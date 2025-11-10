/*
 * Lightweight tab UI initializer
 * -----------------------------
 * Toggle tab panes when a button with `.tab-button` is clicked. Adds/removes
 * the `active` class on buttons and panes to control visible content.
 */
document.addEventListener("DOMContentLoaded", () => {
  const tabButtons = document.querySelectorAll(".tab-button");
  const tabPanes = document.querySelectorAll(".tab-pane");

  tabButtons.forEach(button => {
    button.addEventListener("click", () => {
      // Remove active class from all buttons and panes
      tabButtons.forEach(btn => btn.classList.remove("active"));
      tabPanes.forEach(pane => pane.classList.remove("active"));

      // Add active class to clicked button and corresponding pane
      button.classList.add("active");
      const tabId = button.getAttribute("data-tab");
      document.getElementById(tabId).classList.add("active");
    });
  });
});