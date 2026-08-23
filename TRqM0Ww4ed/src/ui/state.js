/* Purely visual state: which unit is selected, and which unit kind is armed for
   recruiting. Kept out of game.js so the rule layer stays free of interface concerns. */

export const ui = {
  selected: null,   // unit id the player is giving orders to
  recruit: null,    // unit kind armed for placement, or null
  build: null,      // structure armed for placement ("port"), or null
};

export const clearUi = () => { ui.selected = null; ui.recruit = null; ui.build = null; };
