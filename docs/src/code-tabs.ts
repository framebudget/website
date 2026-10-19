import { all, tablist } from "./ui";

/** The code examples ("Six ways in"): selecting a tab shows its panel and hides the others. */
export function mountCodeTabs(): void {
  for (const list of all("[data-tabs]")) {
    const tabs = all<HTMLButtonElement>('[role="tab"]', list);
    tablist(list, (selected) => {
      for (const tab of tabs) {
        const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
        panel?.toggleAttribute("data-inactive", tab !== selected);
      }
    });
  }
}
