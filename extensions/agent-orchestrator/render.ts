/**
 * TUI rendering for teammate mail.
 *
 * The renderer itself is shared with the fork-session extension; this file only
 * binds it to the team vocabulary (an unattributed message is from a
 * "teammate").
 */

import { createMailRenderer } from "../_shared/mail-render.ts";

/** Renderer for the `team-message` custom type produced by index.ts `deliver()`. */
export const renderTeamMessage = createMailRenderer("teammate");
