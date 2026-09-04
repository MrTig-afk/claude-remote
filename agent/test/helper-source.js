// Shared source-reading helpers for the suites that assert on shipped files.
//
// codeOnly exists because this project has repeatedly written a comment that
// EXPLAINS a rule and thereby failed the test ENFORCING it - a grep for
// `waitForAgent` matching the comment saying waitForAgent is the wrong thing
// here, and three more like it. A claim about what the code DOES must not be
// answered by what the source SAYS.

/** Source with block and line comments removed. */
export function codeOnly(js) {
  return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
