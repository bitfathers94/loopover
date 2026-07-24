import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TypingIndicator } from "./typing-indicator";

describe("TypingIndicator (#6515)", () => {
  it("renders three bouncing dots under a polite status with a typing-specific label", () => {
    render(<TypingIndicator />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Assistant is typing…")).toBeTruthy();
    const dots = document.querySelectorAll("span[aria-hidden='true']");
    expect(dots).toHaveLength(3);
  });

  it("guards every bounce dot with motion-reduce:animate-none so it stops under reduce-motion (#8303)", () => {
    render(<TypingIndicator />);
    const dots = Array.from(document.querySelectorAll<HTMLElement>("span[aria-hidden='true']"));
    for (const dot of dots) {
      expect(dot.className).toContain("animate-bounce");
      expect(dot.className).toContain("motion-reduce:animate-none");
    }
  });

  it("uses the given author name in its accessible label", () => {
    render(<TypingIndicator authorName="Codex" />);
    expect(screen.getByText("Codex is typing…")).toBeTruthy();
  });

  it("renders nothing when the other side isn't composing", () => {
    const { container } = render(<TypingIndicator composing={false} />);
    expect(container.firstChild).toBeNull();
  });
});
