/**
 * Strip credential-shaped env vars before handing the environment to a
 * long-lived child process (PHP worker, Intelephense LSP, ssh client).
 * The scratchpad is a REPL — any code the user pastes can read its own
 * environment via `getenv()`, and bundled third-party code (Intelephense)
 * is still code we'd rather not hand our shell secrets to. SSH in
 * particular can be configured to `SendEnv` arbitrary variables to the
 * remote, so we scrub upstream of that too.
 *
 * Names matching common secret prefixes/keywords are dropped; everything
 * else (PATH, HOME, locale, PHP_* overrides, Laravel / Composer tunables)
 * passes through.
 */
export function scrubbedEnv(): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    const sensitivePrefixes = [
        "AWS_",
        "AZURE_",
        "GCP_",
        "GOOGLE_",
        "GITHUB_",
        "GITLAB_",
        "BITBUCKET_",
        "DOCKER_",
        "KUBE",
        "NPM_TOKEN",
        "NPM_CONFIG__AUTH",
        "HOMEBREW_GITHUB_API_TOKEN",
        "SSH_AUTH_SOCK",
        "GPG_AGENT_INFO",
    ];
    const sensitiveNeedles = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH)/i;
    for (const [k, v] of Object.entries(process.env)) {
        if (sensitivePrefixes.some((p) => k === p || k.startsWith(p))) continue;
        if (sensitiveNeedles.test(k)) continue;
        out[k] = v;
    }
    return out;
}
