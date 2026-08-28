import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { htmlToPlainText } from "./html-to-text.ts";

// The plain-text alternative this produces is what recipients' clients fall back
// to and what spam filters weigh against the HTML part, so its output shape
// matters beyond "roughly readable".
describe("htmlToPlainText", () => {
  test("returns empty string for empty input", () => {
    assert.equal(htmlToPlainText(""), "");
  });

  test("passes plain text through", () => {
    assert.equal(htmlToPlainText("Hello there"), "Hello there");
  });

  test("separates block elements with a blank line", () => {
    assert.equal(htmlToPlainText("<p>One</p><p>Two</p>"), "One\n\nTwo");
  });

  test("turns <br> into a single newline", () => {
    assert.equal(htmlToPlainText("a<br>b"), "a\nb");
  });

  test("renders <hr> as a divider", () => {
    assert.equal(htmlToPlainText("<p>a</p><hr><p>b</p>"), "a\n\n---\n\nb");
  });

  test("prefixes list items with a dash", () => {
    assert.equal(htmlToPlainText("<ul><li>one</li><li>two</li></ul>"), "- one\n- two");
  });

  test("drops script and style content entirely", () => {
    assert.equal(
      htmlToPlainText("<p>keep</p><script>alert(1)</script><style>p{color:red}</style>"),
      "keep"
    );
  });

  test("collapses runs of whitespace within a line", () => {
    assert.equal(htmlToPlainText("<p>a     b</p>"), "a b");
  });

  test("collapses three or more newlines down to a blank line", () => {
    assert.equal(htmlToPlainText("<div><div><div>a</div></div></div><p>b</p>"), "a\n\nb");
  });

  describe("links", () => {
    test("appends the href when the text differs", () => {
      assert.equal(
        htmlToPlainText('<a href="https://example.com">Click here</a>'),
        "Click here (https://example.com)"
      );
    });

    test("does not duplicate when the text already is the href", () => {
      assert.equal(
        htmlToPlainText('<a href="https://example.com">https://example.com</a>'),
        "https://example.com"
      );
    });

    test("falls back to the href when there is no link text", () => {
      assert.equal(htmlToPlainText('<a href="https://example.com"></a>'), "https://example.com");
    });

    test("renders the text alone when the href is empty", () => {
      assert.equal(htmlToPlainText('<a href="">bare</a>'), "bare");
    });

    test("strips the mailto: scheme from the displayed address", () => {
      assert.equal(htmlToPlainText('<a href="mailto:a@b.com">Email us</a>'), "Email us (a@b.com)");
    });

    test("treats text matching the scheme-stripped href as a duplicate", () => {
      assert.equal(htmlToPlainText('<a href="mailto:a@b.com">a@b.com</a>'), "a@b.com");
    });
  });
});
