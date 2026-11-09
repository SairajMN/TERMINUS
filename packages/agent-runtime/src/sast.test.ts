import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCode, scanFiles } from "./sast";

describe("sast static security scanner", () => {
  it("detects command injection vectors (eval, new Function, child_process.exec)", () => {
    const code = `
      function runUser(input) {
        return eval(input);
      }
      const fn = new Function("a", "b", "return a + b");
      child_process.exec(cmd);
    `;
    const findings = scanCode(code, "service.js");
    expect(findings.length).toBe(3);
    expect(findings.every((f) => f.ruleId === "OWASP-A03-COMMAND-INJECTION")).toBe(true);
    expect(findings.every((f) => f.severity === "blocker")).toBe(true);
  });

  it("detects SQL injection via template literals inside query methods", () => {
    const code = `
      const queryUser = (id) => db.query(\`SELECT * FROM users WHERE id = \${id}\`);
      const rawRun = (table) => knex.raw(\`DROP TABLE \${table}\`);
    `;
    const findings = scanCode(code, "db.js");
    expect(findings.length).toBe(2);
    expect(findings.every((f) => f.ruleId === "OWASP-A03-SQL-INJECTION")).toBe(true);
  });

  it("detects hardcoded private keys", () => {
    const code = `
      const key = "-----BEGIN RSA PRIVATE KEY-----\\nMIIE...";
    `;
    const findings = scanCode(code, "crypto.js");
    expect(findings.length).toBe(1);
    expect(findings[0]?.ruleId).toBe("OWASP-A02-HARDCODED-PRIVATE-KEY");
    expect(findings[0]?.severity).toBe("blocker");
  });

  it("detects hardcoded secret tokens", () => {
    const code = `
      const config = {
        api_key: "abcdef1234567890",
        db_password: "super_secret_password_here"
      };
    `;
    const findings = scanCode(code, "config.js");
    expect(findings.length).toBe(2);
    expect(findings.every((f) => f.ruleId === "OWASP-A02-HARDCODED-SECRET")).toBe(true);
  });

  it("detects XSS and unsafe innerHTML injections", () => {
    const code = `
      element.innerHTML = userContent;
      const v = <div dangerouslySetInnerHTML={{ __html: rawHtml }} />;
    `;
    const findings = scanCode(code, "component.jsx");
    expect(findings.length).toBe(2);
    expect(findings.every((f) => f.ruleId === "OWASP-A03-XSS-INNER-HTML")).toBe(true);
  });

  it("scans files within a workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "terminus-sast-"));
    writeFileSync(join(root, "app.js"), "const x = eval('1+1');\n");
    const findings = scanFiles(["app.js"], root);
    expect(findings.length).toBe(1);
    expect(findings[0]?.snippet).toContain("eval('1+1')");
  });
});
