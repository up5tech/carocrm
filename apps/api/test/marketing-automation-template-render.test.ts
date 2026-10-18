import { describe, expect, it } from "vitest";

import {
  decodeHtmlEntities,
  escapeHtmlValue,
  MARKETING_PLACEHOLDERS,
  plainTextFromHtml,
  PREVIEW_SYSTEM_LINK_SENTINELS,
  renderMarketingTemplate,
  type RenderOutput,
  requiredLinkFindings,
  sanitizeMarketingHtml,
  templateContentHash,
  validateMarketingLinks,
} from "../src/marketing-automation/marketing-template-render.js";

/**
 * Phase 19-MA.6 — the marketing content renderer, tested as pure functions
 * (PLAN_Phase_19_Marketing_Automation.md §5.4, §9.4, §15 `19-MA.6` acceptance).
 *
 * These are the rules the plan pins to the phase without a database: unsafe markup is dropped rather
 * than repaired, unknown or unsettled placeholders are reported instead of leaking, link schemes are
 * validated the way a mail client would resolve them, and the content hash is stable enough to be the
 * value a delivery record cites.
 */

const baseInput = {
  template: {
    subject: "Hello {{ recipientFirstName }}",
    body: "Hello {{recipientName}}, welcome!",
    bodyHtml: "<p>Hello <b>{{recipientName}}</b>, <a href=\"https://example.com/offer\">see the offer</a>.</p>",
  },
  campaign: { name: "Spring", code: "SPR-01", objective: null, startsAt: null, endsAt: null },
  recipient: { name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace", emailAddress: "ada@example.com" },
  consentRequired: true,
} as const;

// ---------------------------------------------------------------------------
// Placeholders and escaping
// ---------------------------------------------------------------------------

describe("marketing placeholder allowlist", () => {
  it("names exactly the recipient, campaign and system values the plan documents", () => {
    const groups = MARKETING_PLACEHOLDERS.map((definition) => definition.group);
    expect(groups.every((group) => group === "recipient" || group === "campaign" || group === "system")).toBe(true);
    for (const name of ["recipientName", "recipientEmailAddress", "campaignName", "unsubscribeUrl", "preferenceUrl"]) {
      expect(MARKETING_PLACEHOLDERS.some((definition) => definition.name === name)).toBe(true);
    }
  });

  it("escapes the five HTML delimiters", () => {
    expect(escapeHtmlValue(`a<b>c&"d'e`)).toBe("a&lt;b&gt;c&amp;&quot;d&#39;e");
    expect(decodeHtmlEntities("a&lt;b&gt;c&amp;&quot;d&#39;e")).toBe(`a<b>c&"d'e`);
  });
});

describe("renderMarketingTemplate", () => {
  const render = (overrides: Partial<typeof baseInput> = {}) =>
    renderMarketingTemplate({ ...baseInput, ...overrides } as typeof baseInput);

  it("resolves recipient, campaign and system values from the context", () => {
    const output = render({
      template: { ...baseInput.template, body: "Hello {{recipientName}}, welcome from {{campaignName}}!" },
    });
    expect(output.subject).toBe("Hello Ada");
    expect(output.bodyText).toBe("Hello Ada Lovelace, welcome from Spring!");
    expect(output.resolved).toContain("recipientName");
    expect(output.resolved).toContain("campaignName");
    expect(output.systemLinks).toEqual([]);
  });

  it("reports an unknown placeholder and renders it empty instead of leaking an error", () => {
    const output = render({
      template: { ...baseInput.template, body: "Hi {{not_a_placeholder_name}}" },
    });
    expect(output.unresolved).toEqual(["not_a_placeholder_name"]);
    expect(output.bodyText).toBe("Hi ");
    expect(output.findings.map((finding) => finding.code)).toContain("PLACEHOLDER_UNKNOWN");
  });

  it("uses the documented fallback for a missing recipient value and reports it", () => {
    const output = render({ recipient: null });
    expect(output.bodyText).toBe("Hello , welcome!");
    expect(output.fallbacks.map((fallback) => fallback.name)).toContain("recipientName");
    expect(output.fallbacks.map((fallback) => fallback.name)).toContain("recipientFirstName");
    expect(output.fallbacks.every((fallback) => fallback.group === "recipient")).toBe(true);
  });

  it("escapes inserted values in the HTML output, so a hostile field value cannot break out", () => {
    const output = render({
      recipient: { name: `Ada<script>alert(1)</script>`, firstName: "Ada", lastName: `"><img src=x onerror=alert(1)>`, emailAddress: "ada@example.com" },
    });
    expect(output.bodyHtml).not.toContain("<script>");
    expect(output.bodyHtml).not.toContain("onerror");
    expect(output.bodyHtml).toContain("&lt;script&gt;");
    // The template's own <b>, <p> and <a> survive: sanitisation drops what the author did not write.
    expect(output.bodyHtml).toContain("<b>Ada");
  });

  it("renders system link placeholders with the preview sentinel and notes that the send inserts real ones", () => {
    const output = render({
      template: {
        ...baseInput.template,
        bodyHtml: `<p>Quote with {{currentYear}}. <a href="{{unsubscribeUrl}}">Unhere</a>, or <a href="{{preferenceUrl}}">Preferences</a>.</p>`,
      },
    });
    expect(output.systemLinks.sort()).toEqual(["preferenceUrl", "unsubscribeUrl"]);
    expect(output.bodyHtml).toContain(PREVIEW_SYSTEM_LINK_SENTINELS.unsubscribeUrl);
    const note = output.findings.find((finding) => finding.code === "SYSTEM_LINK_INSERTED_AT_SEND");
    expect(note?.level).toBe("warning");
    // A consent-required purpose with the opt-out link present raises no footer finding.
    expect(output.findings.map((finding) => finding.code)).not.toContain("FOOTER_MISSING");
  });

  it("demands the opt-out link for consent-required purposes, but not for a service notice", () => {
    const output = render();
    expect(output.findings.map((finding) => finding.code)).toContain("FOOTER_MISSING");
    const notice = render({ consentRequired: false });
    expect(notice.findings.map((finding) => finding.code)).not.toContain("FOOTER_MISSING");
  });

  it("generates a plain-text fallback when the template carries no text body", () => {
    const output = render({
      template: {
        subject: "Hi",
        body: null,
        bodyHtml: "<p>Hi {{recipientFirstName}},</p><p>Row 1<br>Row 2</p>",
      },
    });
    expect(output.plainTextSource).toBe("generated");
    expect(output.plainText).toBe("Hi Ada,\nRow 1\nRow 2");
    expect(output.generatedText).toBe(output.plainText);
  });

  it("uses the template's own text body when present and keeps the generated one separate", () => {
    const output = render({
      template: { ...baseInput.template, body: "Text version for {{recipientFirstName}}" },
    });
    expect(output.plainTextSource).toBe("template");
    expect(output.plainText).toBe("Text version for Ada");
  });

  it("carries the raw-content hash that a send's delivery record will cite", () => {
    const output = render();
    expect(output.templateContentHash).toBe(
      templateContentHash({ subject: baseInput.template.subject, body: baseInput.template.body, bodyHtml: baseInput.template.bodyHtml }),
    );
  });
});

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

describe("sanitizeMarketingHtml", () => {
  const sanitize = (html: string) => sanitizeMarketingHtml(html);

  it("keeps the tags and attributes the allowlist knows", () => {
    const result = sanitize(
      `<P ONCLICK=alert(1)>a</P><table border="2"><td colspan="2">c</td></table><img src="https://x/y.png" alt="photo" onerror="alert(1)">`,
    );
    expect(result.html).toBe(`<p>a</p><table border="2"><td colspan="2">c</td></table><img src="https://x/y.png" alt="photo">`);
  });

  it("removes script, style and iframe blocks including their content", () => {
    expect(sanitize(`<p>a</p><script>alert(1)</script><p>b</p>`).html).toBe("<p>a</p><p>b</p>");
    expect(sanitize("<style>*{}</style><p>keep</p>").html).toBe("<p>keep</p>");
    // An unterminated block removes everything after its opening tag rather than emitting it.
    expect(sanitize("<p>a</p><script>alert(1)").html).toBe("<p>a</p>");
    expect(sanitize(`<p>a</p><iframe src="https://evil.example"><p>gone</p>`).html).toBe("<p>a</p>");
  });

  it("drops every unsafe URL scheme, including entity-encoded and control-split forms", () => {
    const result = sanitize(
      [
        `<a href="javascript:alert(1)">a</a>`,
        `<a href="jav&#x09;ascript:alert(1)">b</a>`,
        `<a href=" JAVASCRIPT:alert(1)">c</a>`,
        `<a href="vbscript:msgbox">d</a>`,
        `<a href="data:text/html,<script>">e</a>`,
      ].join(""),
    );
    expect(result.html).not.toContain("javascript");
    expect(result.html).not.toContain("vbscript");
    expect(result.html).not.toContain("data:");
    expect(result.removed).toContain("a.href");
    // The anchor stays; only its impossible destination goes.
    expect(result.html).toContain("</a>");
  });

  it("keeps http, https and mailto destinations, and drops relative ones in either attribute", () => {
    const ok = sanitize(`<a href="https://ok.example/x?a=1&amp;b=2">y</a><a href="mailto:a@b.example">m</a>`);
    expect(ok.html).toBe(`<a href="https://ok.example/x?a=1&amp;b=2">y</a><a href="mailto:a@b.example">m</a>`);
    const relative = sanitize(`<img src="/logo.png" alt="logo"><a href="/relative">r</a>`);
    expect(relative.html).toBe(`<img alt="logo"><a>r</a>`);
    expect(validateMarketingLinks(relative.html)).toEqual([]);
  });

  it("never emits a malformed tag as markup", () => {
    // A `<` that opens nothing parseable becomes text, not the start of markup the reader's client sees.
    expect(sanitize(`5 < 6 and <b>bold</b>`).html).toBe(`5 &lt; 6 and <b>bold</b>`);
    // Nested-tag smuggling (`<scr<script>ipt>") degrades to harmless text.
    const smuggled = sanitize(`<scr<script>ipt>alert(1)</scr</script>ipt>`);
    expect(smuggled.html).not.toMatch(/<[^>]*script/);
    // A quoted `>` cannot cut the tag off mid-attribute and let the rest through as a second tag.
    const quoted = sanitize(`<a title="</a><script>alert(1)</script>">x</a>`);
    expect(quoted.html).not.toContain("<script");
    expect(quoted.html).toContain(">x</a>");
  });

  it("drops inline styles and reports it, keeping the text content", () => {
    const result = sanitize(`<p style="background:url(https://x)">text</p>`);
    expect(result.html).toBe("<p>text</p>");
    expect(result.removed).toContain("style-attribute");
  });

  it("drops comments and their conditional forms, exposing nothing executable", () => {
    const result = sanitize(`<!--[if gte mso 9]><script>x</script><![endif]--><p>ok</p><!-- secret -->`);
    expect(result.html).not.toContain("<script");
    expect(result.html).toContain("<p>ok</p>");
  });
});

// ---------------------------------------------------------------------------
// Links, plain text, content hash
// ---------------------------------------------------------------------------

describe("validateMarketingLinks and requiredLinkFindings", () => {
  it("warns on a link whose scheme the filter refused, in the sanitised output", () => {
    const findings = validateMarketingLinks(`http://ok/[relative]"...<a href="#">none</a>`);
    // Relative URLs and fragments are the visible case; the scheme check is the mail-client view.
    expect(findings.map((finding) => finding.code)).toContain("LINK_NOT_ALLOWED");
  });

  it("answers null when the content carries an opt-out placeholder and a finding when it does not", () => {
    expect(requiredLinkFindings(["<p>Hi {{ recipientFirstName }}</p>"], true)?.code).toBe("FOOTER_MISSING");
    expect(requiredLinkFindings(["<a href=\"{{unsubscribeUrl}}\">Unsubscribe</a>"], true)).toBeNull();
    expect(requiredLinkFindings(["{{preferenceUrl}}"], true)).toBeNull();
    // A ServiceNotice carries no such obligation (§5.3).
    expect(requiredLinkFindings(["no links at all"], false)).toBeNull();
  });
});

describe("plainTextFromHtml", () => {
  it("turns block structure into newlines and resolves entities", () => {
    expect(plainTextFromHtml(`<h2>Head</h2><p>First &amp; second<br>third</p><ul><li>one</li><li>two</li></ul>`))
      .toBe("Head\nFirst & second\nthird\n\n- one\n- two");
  });

  it("collapses blank runs and trims", () => {
    expect(plainTextFromHtml(`<p>a</p>   <p></p><p>b</p>`)).toBe("a\n\nb");
  });
});

describe("templateContentHash", () => {
  it("is order-stable and content-sensitive", () => {
    const one = templateContentHash({ subject: "a", body: null, bodyHtml: "<p>x</p>" });
    expect(templateContentHash({ body: null, bodyHtml: "<p>x</p>", subject: "a" })).toBe(one);
    expect(templateContentHash({ subject: "a", body: null, bodyHtml: "<p>y</p>" })).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{32}$/);
  });

  it("answers the acceptance question: the content that would actually go out is traceable", () => {
    // A sealed revision of content C must hash to the same value a render of that content reports,
    // so a later delivery record (MA.7–MA.9) can cite hash + revision id for what it produced.
    const content = { subject: "Hello", body: null, bodyHtml: "<p>Hi {{recipientName}}</p>" };
    const output: RenderOutput = renderMarketingTemplate({
      template: content,
      campaign: { name: null, code: null, objective: null, startsAt: null, endsAt: null },
      recipient: { name: "Ada", firstName: "Ada", lastName: null, emailAddress: null },
      consentRequired: true,
    });
    expect(output.templateContentHash).toBe(templateContentHash(content));
  });
});
