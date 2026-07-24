import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./accordion";

// Regression guard for #8303: the animated Radix content families used to pair their `animate-*` /
// `data-[state=*]:animate-in|out` utilities with no `motion-reduce:` companion, so a user with the OS
// "reduce motion" preference still got full animation — unlike Skeleton / Spinner / Button / Tabs, which
// already disable their animation under `motion-reduce:`. Assert one such content component now carries the
// `motion-reduce:animate-none` counterpart on its animated class list (the same class-list-assertion shape
// state-views.test.tsx uses). ui-kit is not Codecov-gated; the acceptance signal is that this runs and passes.
describe("reduced-motion (#8303)", () => {
  it("AccordionContent pairs its accordion animation with motion-reduce:animate-none", () => {
    const { container } = render(
      <Accordion type="single" defaultValue="a" collapsible>
        <AccordionItem value="a">
          <AccordionTrigger>Section</AccordionTrigger>
          <AccordionContent>Body</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    const animated = Array.from(container.querySelectorAll("*")).find((el) =>
      el.getAttribute("class")?.includes("animate-accordion-down"),
    );
    expect(animated).toBeTruthy();
    expect(animated!.getAttribute("class")).toContain(
      "motion-reduce:animate-none",
    );
  });
});
