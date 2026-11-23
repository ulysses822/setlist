// Step-by-step undo for the open playlist's draft.
//
// The app's promise is that nothing reaches Spotify unreviewed, and that has always held. What
// it never covered is the draft itself: until edits could be made in bulk, a mistake cost one
// track, and `revert` — which discards everything back to the last synced version — was a
// proportionate escape. One click can now remove forty, so it isn't.
//
// Deliberately undo only, with no redo. An undo press is a correction, and the thing it
// corrects can be done again by hand; a redo stack would double the state that has to stay
// consistent with the draft, the staged file and the diff, to buy back something rarer.

import { sameContent, type Content } from "./draftState";

/**
 * How many steps back the editor can go. Fifty is far more than anyone retraces by hand, and
 * the point of a cap is that an afternoon's editing can't pin every intermediate track list
 * in memory.
 *
 * Keeping fifty is cheap because a step holds the content object the draft was using rather
 * than a copy of it. Every edit replaces that object instead of mutating it, so the old one
 * is already an immutable record of how things were.
 */
export const UNDO_LIMIT = 50;

/**
 * Record a point to come back to.
 *
 * One press of undo should move one step the user would recognise, which is what the two
 * rules here are for. A step identical to the one already on top is dropped, because an edit
 * that changed nothing is not a step and should not have to be undone twice. And the stack is
 * capped from the old end, so the steps it keeps are the recent ones.
 *
 * Returns the same array when there is nothing to record, so a caller holding this in state
 * re-renders only when the stack really changed.
 */
export function recordSnapshot(stack: Content[], snapshot: Content): Content[] {
  if (stack.length > 0 && sameContent(stack[stack.length - 1], snapshot)) return stack;
  const next = [...stack, snapshot];
  return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
}

/** The step to go back to and the stack that remains, or null when there's nothing to undo. */
export function popSnapshot(
  stack: Content[]
): { snapshot: Content; rest: Content[] } | null {
  if (stack.length === 0) return null;
  return { snapshot: stack[stack.length - 1], rest: stack.slice(0, -1) };
}
