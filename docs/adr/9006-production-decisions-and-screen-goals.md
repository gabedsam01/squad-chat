# 9006. Only production decisions, a target found by choice, and goals a screen reaches in fast steps

- Status: Accepted
- Date: 2026-11-18
- Builds on: ADR 0054 (a fast browser: the screen layer, targets in words), ADR 0062 (desktop computer use), ADR 9001 (an optional decision model beside Jev)
- Changes: ADR 0054 §2 (targets on an image are found by choice, never a box), ADR 9001 §4 and §6 (the box question and pictures go to Jev no more; pictures go to the decision model when it reads them)
- Code: `packages/engine/src/judge.ts`, `packages/engine/src/decision-model.ts`, `packages/engine/src/screen/targets.ts`, `packages/engine/src/screen/goal.ts` (new), `browser/tools.ts`, `desktop/tools.ts`

## Context

Jev's image input and its Box question are a preview at TypeSafe. Requests must send the `TypeSafe-Danger-Zone-Images: true` header and use the model `jev-preview`, and TypeSafe says they are not ready for production (Jev 1.14, October 2026). The agent browser and the desktop used them to find a target on a screenshot. A production path cannot depend on a preview that its maker has not released.

Two decision APIs now serve production traffic with images:

- OpenAI's Decisions API (`POST /v1/decisions`, model `gpt-6-luna`) answers predicate, choice (2 to 255 choices) and score, up to 400 questions per request, over text, JSON and images (`detail` low, high, auto or original).
- Gemini's Decisions API (`gemini-decision-1`) answers noul, choice (2 to 255 options) and score, up to 1,000 questions per request over a 262,144-token input, with text, images, audio, video and PDF. It takes an image `resolution` from low to ultra_high and answers in about 150 to 250 ms end to end.

Neither API has a box. A box has to come from the model's own description, so a target on an image has to be found in another way.

Browser Use's Jev Ultrafast experiment showed the other lever. Per step, one request picks an operation and, speculatively, the element for each operation over a numbered table of the page's elements. The large model leaves the per-click loop. Their Google Flights search finished in 7.1 s.

## Decision

1. **Only release features in Jev's path.** Jev answers text questions only. Images, the Box question and the `TypeSafe-Danger-Zone-Images` header go. `JEV_VISION_MODEL` is removed. A judgment over an image goes only to the installation's decision model (ADR 9001) when that model is on and its recorded capabilities include images. Otherwise the judgment fails and its caller does without it, as for any judge that is off. The `box` question leaves the judge and the decision providers. Whether a plan may look at images is `DecisionModel.seesImages()`.

2. **A target is found without a box.** `locateOnImage` (`packages/engine/src/screen/targets.ts`) asks choice and yes/no questions only, and draws its own marks on the picture when it needs them (`screen/crop.ts`: a small PNG decoder, since Bun's image API crops and draws nothing).
   - With the screen's elements (marks), one choice picks among them and lands on that element's ref. Each is listed with its role, its name and where its center is on the screenshot: a desktop's screenshot has no numbers drawn on it, and GPT took the Edit menu for a search button known by role and name alone. A named mark picked at 0.75 or more is taken as it is (every right pick of both models was), even when the same answer says the target isn't there (GPT did, at 0.01, for a pick of 0.99). Any other pick is checked as below, and a no goes on to the cells: a mark without a name is picked by its looks alone, and GPT took a terminal's panel button for its text area at 0.62.
   - Without marks, the region is split into a 3×3 grid of overlapping cells. Each cell is asked in its own request, all at once, whether the control's center is inside a red rectangle drawn on the whole region around that cell. The surest cell goes on with the cells beside it that also say yes (a wide control says yes in several); past the first round a cell well above all the others goes on even when it isn't sure. It repeats on a close-up of that region, at most 4 rounds, until it is small enough or no narrower.
   - Where to click is the last round's cells' centers weighed by how sure each is. That spot is then checked: a red crosshair with an empty middle (wider than a small control, so it hides none) drawn on a close-up kept inside the screen and enlarged up to twice, and one yes/no on whether its middle sits on the control. The aim, the centers of the two surest cells and four spots 8 px beside the aim are checked at once; when none is a yes, once more around the surest of them. A no is unsure and goes back to the agent.
   - Rectangles and crosshairs are drawn on the picture at the size it is sent, in a grey margin around it, the rectangle just outside its cell. Drawn on the screen's pixels before a close-up was enlarged three times, a rectangle's sides were 20 px wide there; and a side or an arm on the screen's edge lay over the window's close button in the corner, or wasn't drawn at all.
   - Whether the target is there and whether acting can't be undone are asked once, on the whole screen, beside the marks' choice or else beside the first round. A target whose action can't be undone is never taken at a bare point, as before (ADR 0062).
   - The questions ask for what `target` describes (a control, a field, a picture or text), not only for a control that does it. A desktop's address (`desktop://thunar/main`) is left out of the state: with it, GPT said a browser's address bar on that screen wasn't there (0.00; 1.00 without it).

   Measured with `eval:desktop:micro` against `gemini-decision-1` (two trials, the recorded scenes of ADR 0062):
   - Nine named pictures in one request were told apart badly. One cell cut out per request did well on the first round and lost its way after it: a close-up alone loses what is around it. The rectangle on the whole region keeps that context.
   - Small targets 28/32 on the first pass, two of the misses the service being unavailable (Jev's Box: 22/39), large targets 8/8 (Box: 15/15), absent targets 8/8, choice over the tree 14/14 (median 186 ms). No click on a wrong spot: every miss was an unsure target given back to the agent, or a dialog's close button refused at a bare spot because closing it discards the text. The 18-px close button of a window in the screen's corner is found.
   - With marks a target takes about 0.9 s. Without them, about 13 s (each round is nine requests at once, then the checks) and about 30,000 input tokens: an account's tokens a minute (50,000 on the measured one) bound how often it can run.
   - OpenAI's `gpt-6-luna`, measured the same way through OpenRouter's Decisions API (`openai/gpt-6-luna-decisions`, the eval's `DECISION_PROVIDER=openrouter`; there it takes pictures only as parts of a list `state`): small targets 25/32, large 7/8, absent 8/8, checks on the image 7/7, about 9 s without marks and 750,000 input tokens for the run (Gemini: 1.2 million). Every pick among the marks is right; it clicks a wrong spot 4 times in 40, all found on the cells beside a small close button or an edge: its check says yes to a spot 10 to 25 px away. No question tried (a stricter check, a choice against everything else) told those apart, and kept to the marks it found 17/32 and 1/8, so it is not: Gemini is the one to pick for a computer.
   - Each provider has its own image detail setting (Gemini's `resolution`, up to `ultra_high`; OpenAI's `detail`, up to `original`). Both are left at their defaults: Gemini's is already its `high` (1,120 tokens), and a screen at `ultra_high` placed the target no better in the measure above.

3. **A `goal` step.** `browser_do` and `desktop_do` take `{ do: "goal", goal, values?, steps? }` (`packages/engine/src/screen/goal.ts`). Each step is one judge request over the screen's element table. The answer holds:
   - the operation: click, type, select, scroll down, scroll up, wait, done or blocked;
   - speculatively, the target for each operation, among the elements that fit it;
   - which of the agent's `values` to type or select;
   - whether the goal is reached.

   The decision model answers it: any of the installation's models (OpenAI, Gemini, local, or Jev on text), falling back down the existing chain. Text typed comes only from `values` the agent wrote. No model writes text inside the loop.

   The loop stops on:
   - done, after the check;
   - blocked;
   - an unsure pick;
   - a target whose action can't be undone, which is handed back to the agent with what the loop would have done;
   - no change twice in a row;
   - a person taking the screen;
   - the step limit (default 12, at most 25);
   - a cancel.

   `open`, `back` and `type_secret` are not allowed inside a goal. Every action the loop takes is a step in the plan's report, like any other step.

## Consequences

- A server without a decision model that reads images finds targets from text only: refs, words, site memory, and the judge's choice over text. It loses the image path and keeps the rest.
- An agent reaches a short goal in one tool call instead of one model turn per action. The big model is called once to start the plan and when a step is unsure; the loop does not call it per click.
- The cost per step is one decision request. Its price is the decision model's price (ADR 9001 §7).
- Jev without images stays the text judge and the router. Its price and its role as the first step do not change.
- The loop never acts on what can't be undone. It hands that step back to the agent.
- Confidential threads (ADR 0190) get no judge, so no goal runs in them.
- Eval and the desktop smoke test of ADR 0062 cover the goal step before it is turned on for a desktop.
