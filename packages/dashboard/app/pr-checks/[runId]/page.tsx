// The detailed risk-ranked diff already lives in the review implementation.
// Expose the same durable view under the dedicated PR checks workspace so a
// user never has to open a session first to find it.
export { default } from "../../runs/[runId]/review/page";
