/** MANUAL ENVIRONMENT SMOKE TEST, NOT AN AI-GENERATED RESEARCH RESULT. */
import { canEditPost } from "./canEditPost";
test("owner can edit", () => expect(canEditPost("u1", "u1")).toBe(true));
test("nonowner cannot edit", () => expect(canEditPost("u2", "u1")).toBe(false));
test("signed-out user cannot edit", () => expect(canEditPost(null, "u1")).toBe(false));
