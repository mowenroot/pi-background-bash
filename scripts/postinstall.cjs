// Applies dev-only patches (pi-mock) when patch-package is available — i.e. in
// this repo after `npm install` (devDependencies present). Silently skips when
// the package is installed as a dependency: consumers never receive pi-mock or
// the patches directory, and patch-package is not among runtime dependencies.
const { execSync } = require("node:child_process");

try {
	execSync("patch-package", { stdio: "inherit" });
} catch {
	// patch-package binary unavailable (consumer install) — nothing to patch.
}
