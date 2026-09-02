import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import puppeteer from "puppeteer";

/**
 * Garmin Connect's web client authenticates with session cookies plus a
 * `Connect-Csrf-Token` header against a `/gc-api/` proxy. It does NOT send an
 * `Authorization: Bearer` header, and the older `connectapi.garmin.com` surface
 * this project used to target now 404s.
 *
 * The `JWT_WEB` cookie looks like a credential but is not one: a captured
 * request succeeded four minutes after that JWT's `exp`. So there is nothing to
 * parse for expiry - validity has to be probed.
 */
export interface AuthData {
  cookies: string;
  csrfToken: string;
  capturedAt: number;
}

export const GC_API_BASE = "https://connect.garmin.com/gc-api";

/**
 * The minimal header set Garmin accepts, established by dropping headers one at
 * a time against a live session: without any one of these the API answers 403.
 * Everything the previous implementation sent - `di-backend`, `nk`,
 * `x-app-ver`, `x-lang` - is obsolete and ignored.
 */
export function garminHeaders(auth: AuthData, extra: Record<string, string> = {}) {
  return {
    accept: "application/json, text/plain, */*",
    cookie: auth.cookies,
    "Connect-Csrf-Token": auth.csrfToken,
    "Sec-Fetch-Site": "same-origin",
    ...extra,
  };
}

export class GarminAuth {
  private configDir: string;
  private authFile: string;
  private browserProfileDir: string;

  constructor() {
    this.configDir = join(homedir(), ".config", "garmin-connect-workouts-mcp");
    this.authFile = join(this.configDir, "auth.json");
    this.browserProfileDir = join(this.configDir, "browser-profile");

    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Return stored credentials if they still work.
   *
   * Unlike the previous JWT-expiry check this costs a network round trip, but
   * there is no longer any expiry encoded in what we hold. Probing is also
   * strictly more honest: it catches server-side session revocation, which a
   * local timestamp never could.
   */
  async getValidAuth(): Promise<AuthData | null> {
    const stored = this.loadStoredAuth();
    if (!stored) {
      return null;
    }
    return (await this.probe(stored)) ? stored : null;
  }

  /** Cheap authenticated GET used to test whether a session is still live. */
  private async probe(auth: AuthData): Promise<boolean> {
    try {
      const res = await fetch(
        `${GC_API_BASE}/workout-service/workouts?start=1&limit=1`,
        { headers: garminHeaders(auth) }
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Drive a real browser through Garmin's normal web login and capture the
   * resulting session.
   *
   * This deliberately avoids the mobile SSO OAuth flow that `garth` and the
   * wider ecosystem depend on: Garmin broke that on 2026-03-17 and it no longer
   * grants new logins. Driving the web UI also gives us a genuine TLS
   * fingerprint, which Garmin uses to block third-party clients.
   */
  async authenticate(): Promise<AuthData | null> {
    console.error("🚀 Starting Garmin authentication...");

    // A persistent, isolated profile (never the user's personal browser) lets
    // Garmin's own "remember me"/device-trust cookies survive between runs,
    // so a re-login usually doesn't require full credential entry again.
    if (!existsSync(this.browserProfileDir)) {
      mkdirSync(this.browserProfileDir, { recursive: true, mode: 0o700 });
    }

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: false,
        userDataDir: this.browserProfileDir,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      });
    } catch (error) {
      console.error("❌ Failed to launch browser for Garmin login:", error);
      throw new Error(
        "No browser available for the Garmin login. Authentication opens a real Chrome window, so it only works where the server runs locally (e.g. `claude mcp add garmin-workouts npx garmin-connect-workouts-mcp`) - hosted or containerized environments cannot run it. If you ARE running locally and see this, install Puppeteer's browser with: npx puppeteer browsers install chrome"
      );
    }

    let authData: AuthData | null = null;

    try {
      const page = await browser.newPage();

      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      );

      await page.evaluateOnNewDocument(() => {
        delete (navigator as any).webdriver;
      });

      await page.setViewport({ width: 1366, height: 768 });

      let csrfToken = "";

      // The SPA sends Connect-Csrf-Token on every /gc-api/ call, reads included,
      // so simply loading the workouts list surfaces one. Keep the newest: the
      // token is stable for a session, but a re-login mid-flow rotates it.
      page.on("request", (request) => {
        const token = request.headers()["connect-csrf-token"];
        if (token) {
          if (!csrfToken) {
            console.error("🎯 Captured CSRF token!");
          }
          csrfToken = token;
        }
      });

      console.error("🔐 Opening Garmin Connect login...");
      console.error("👉 Please login manually in the browser");

      await page.goto("https://connect.garmin.com/app/workouts", {
        waitUntil: "networkidle2",
      });

      console.error("⏳ Waiting for login completion...");

      // Poll Node-side state rather than waiting on a DOM selector: Garmin
      // reworks the workouts page markup regularly, and a stale selector turns
      // a failed login into a silent five-minute hang.
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        if (csrfToken && !page.url().includes("sso.garmin.com")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!csrfToken) {
        throw new Error(
          "Timed out waiting for login (no CSRF token captured after 5 minutes)."
        );
      }

      const pageCookies = await page.cookies();
      const cookies = pageCookies.map((c) => `${c.name}=${c.value}`).join("; ");

      const candidate: AuthData = {
        cookies,
        csrfToken,
        capturedAt: Date.now(),
      };

      // Verify before storing. Capturing a token proves the browser talked to
      // Garmin; it does not prove the credentials work outside the browser.
      if (!(await this.probe(candidate))) {
        throw new Error(
          "Captured a session but it was rejected by the API. Please try again."
        );
      }

      console.error("✅ Authentication successful!");
      this.storeAuth(candidate);
      authData = candidate;
    } catch (error) {
      console.error("❌ Authentication failed:", error);
    } finally {
      await browser.close();
    }

    return authData;
  }

  private loadStoredAuth(): AuthData | null {
    try {
      if (!existsSync(this.authFile)) {
        return null;
      }
      const parsed = JSON.parse(readFileSync(this.authFile, "utf8"));
      if (!parsed?.cookies || !parsed?.csrfToken) {
        return null;
      }
      return parsed as AuthData;
    } catch (error) {
      console.error("Failed to load stored auth:", error);
      return null;
    }
  }

  private storeAuth(authData: AuthData): void {
    try {
      writeFileSync(this.authFile, JSON.stringify(authData, null, 2), {
        mode: 0o600,
      });
      console.error("💾 Authentication data stored securely");
    } catch (error) {
      console.error("Failed to store auth data:", error);
    }
  }

  /** Remove stored credentials. Deletes the file rather than blanking it. */
  clearAuth(): void {
    try {
      if (existsSync(this.authFile)) {
        rmSync(this.authFile);
        console.error("🗑️ Authentication data cleared");
      }
    } catch (error) {
      console.error("Failed to clear auth data:", error);
    }
  }
}
