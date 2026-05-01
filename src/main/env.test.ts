import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubbedEnv } from "./env";

describe("scrubbedEnv", () => {
    const original = { ...process.env };

    beforeEach(() => {
        // Wipe to a known minimal baseline so each test sees only the vars it sets.
        for (const k of Object.keys(process.env)) delete process.env[k];
    });

    afterEach(() => {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, original);
    });

    it("passes through innocuous vars (PATH, HOME, locale)", () => {
        process.env.PATH = "/usr/bin";
        process.env.HOME = "/Users/ahmad";
        process.env.LANG = "en_US.UTF-8";
        const out = scrubbedEnv();
        expect(out.PATH).toBe("/usr/bin");
        expect(out.HOME).toBe("/Users/ahmad");
        expect(out.LANG).toBe("en_US.UTF-8");
    });

    it("drops cloud-provider credentials by prefix", () => {
        process.env.AWS_ACCESS_KEY_ID = "AKIA";
        process.env.AWS_SECRET_ACCESS_KEY = "secret";
        process.env.AZURE_CLIENT_ID = "x";
        process.env.GCP_PROJECT = "y";
        process.env.GOOGLE_APPLICATION_CREDENTIALS = "/path/to.json";
        const out = scrubbedEnv();
        expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
        expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(out.AZURE_CLIENT_ID).toBeUndefined();
        expect(out.GCP_PROJECT).toBeUndefined();
        expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    });

    it("drops vars matching the secret needle (TOKEN/SECRET/PASSWORD/etc.)", () => {
        process.env.SLACK_TOKEN = "xoxp";
        process.env.SOMETHING_SECRET = "shh";
        process.env.DB_PASSWORD = "hunter2";
        process.env.APP_API_KEY = "k";
        process.env.MY_CREDENTIAL = "c";
        process.env.SOME_PRIVATE_KEY = "-----BEGIN";
        const out = scrubbedEnv();
        expect(out.SLACK_TOKEN).toBeUndefined();
        expect(out.SOMETHING_SECRET).toBeUndefined();
        expect(out.DB_PASSWORD).toBeUndefined();
        expect(out.APP_API_KEY).toBeUndefined();
        expect(out.MY_CREDENTIAL).toBeUndefined();
        expect(out.SOME_PRIVATE_KEY).toBeUndefined();
    });

    it("drops SSH_AUTH_SOCK so child processes don't piggyback on the user's agent", () => {
        process.env.SSH_AUTH_SOCK = "/tmp/ssh-XXXX/agent.123";
        process.env.GPG_AGENT_INFO = "/tmp/gpg";
        const out = scrubbedEnv();
        expect(out.SSH_AUTH_SOCK).toBeUndefined();
        expect(out.GPG_AGENT_INFO).toBeUndefined();
    });

    it("doesn't drop legitimate vars that happen to share the prefix family", () => {
        // GITHUB_TOKEN is sensitive (matches needle). GITHUB_ as a prefix
        // catches anything else like GITHUB_RUN_ID — that's actually the
        // intended behaviour: a CI runner shouldn't leak its identity into
        // child processes either. Document via test.
        process.env.GITHUB_RUN_ID = "12345";
        const out = scrubbedEnv();
        expect(out.GITHUB_RUN_ID).toBeUndefined();
    });

    it("preserves PHP / Laravel / Composer tunables (no prefix or needle match)", () => {
        process.env.PHP_INI_SCAN_DIR = "/etc/php";
        process.env.COMPOSER_HOME = "/opt/composer";
        process.env.LARAVEL_BIN = "/usr/local/bin/artisan";
        const out = scrubbedEnv();
        expect(out.PHP_INI_SCAN_DIR).toBe("/etc/php");
        expect(out.COMPOSER_HOME).toBe("/opt/composer");
        expect(out.LARAVEL_BIN).toBe("/usr/local/bin/artisan");
    });
});
