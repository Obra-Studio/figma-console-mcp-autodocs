import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";
import { AUTODOCS_BODY } from "../vendor/obra-autodocs/autodocs-body.generated.js";

const logger = createChildLogger({ component: "autodocs-tools" });

/**
 * Obra Autodocs, runnable from inside the Desktop Bridge sandbox.
 *
 * The Obra Autodocs Figma plugin draws the labeled grid/bracket documentation
 * around component sets. Running it as a *plugin* would swap the active plugin
 * and tear down the Desktop Bridge connection. Instead we vendor the plugin's
 * code.js (UI-init statements stripped — see scripts/build-autodocs-runtime.mjs)
 * and inject its generate()/remove() entry points over the SAME execute bridge,
 * so the Bridge stays connected throughout.
 *
 * Source of truth: src/vendor/obra-autodocs/code.js. The plugin is stable, so
 * re-vendoring is rare; rerun the build script when code.js is updated.
 */

// JS that loads the label fonts generate() requires, then satisfies the
// plugin's font-readiness gate (_fontLoaded / _fontLoadPromise live in the body
// and are reset to false/null when the body runs, so we set them here, after).
const FONT_PRELUDE = `
await Promise.all([
  figma.loadFontAsync({ family: 'Inter', style: 'Regular' }),
  figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' }),
  figma.loadFontAsync({ family: 'Inter', style: 'Bold' }),
  figma.loadFontAsync({ family: 'Inter', style: 'Italic' }),
  figma.loadFontAsync({ family: 'Inter', style: 'Bold Italic' }),
]);
_fontLoaded = true;
_fontLoadPromise = Promise.resolve();
`;

// Optionally select a target node (and switch to its page) before generating,
// since generate()/remove() operate on figma.currentPage.selection.
function selectSnippet(nodeId?: string): string {
	if (!nodeId) return "";
	return `
const __target = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!__target) return { error: 'Node not found: ' + ${JSON.stringify(nodeId)} };
let __pg = __target; while (__pg && __pg.type !== 'PAGE') __pg = __pg.parent;
if (__pg && figma.currentPage !== __pg) await figma.setCurrentPageAsync(__pg);
figma.currentPage.selection = [__target];
`;
}

function buildGenerateScript(opts: Record<string, unknown>, nodeId?: string): string {
	const entry = `${FONT_PRELUDE}${selectSnippet(nodeId)}
const __cs = getComponentSet();
const __standalone = __cs ? null : getStandaloneComponent();
const __node = __cs || __standalone;
if (!__node) return { error: 'No component set or component selected. Pass nodeId or select one in Figma.' };
const __opts = Object.assign({ showGrid: __standalone ? false : true }, ${JSON.stringify(opts)});
await generate(__opts);
return { generated: true, target: __node.name, type: __node.type, nodeId: __node.id };
`;
	return `${AUTODOCS_BODY}\n${entry}`;
}

function buildRemoveScript(nodeId?: string): string {
	const entry = `${selectSnippet(nodeId)}
const __cs = getComponentSet();
const __node = __cs || getStandaloneComponent();
if (!__node) return { error: 'No component set or component selected. Pass nodeId or select one in Figma.' };
const __wrapper = findExistingWrapper(__node);
const __hasPropstar = __cs ? detectGusPropstar(__cs) : false;
if (!__wrapper && !__hasPropstar) return { removed: false, reason: 'No docs found to remove.' };
if (__hasPropstar) { removeGusPropstar(__cs); } else { removeDocs(); }
return { removed: true, target: __node.name, nodeId: __node.id };
`;
	return `${AUTODOCS_BODY}\n${entry}`;
}

/**
 * Register Obra Autodocs generation/removal tools. Requires a Desktop Bridge
 * connector (local mode). Mirrors registerWriteTools' connector pattern.
 */
export function registerAutodocsTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
) {
	server.tool(
		"figma_generate_autodocs",
		`Generate Obra Autodocs documentation (labeled variant grid with brackets/labels) around a component set or component — the same output as the Obra Autodocs plugin's "Generate docs" command, but run inside the Desktop Bridge so the connection stays alive (running the plugin itself would disconnect the Bridge).

Select the target component set first, or pass its nodeId. Re-running regenerates (replaces) existing docs. Use figma_remove_autodocs to remove them. After generating, screenshot with figma_capture_screenshot to verify.`,
		{
			nodeId: z
				.string()
				.optional()
				.describe(
					"Component set / component node id to document. If omitted, uses the current selection.",
				),
			showGrid: z
				.boolean()
				.optional()
				.default(true)
				.describe("Draw the dashed alignment grid behind the variants (default true; ignored for standalone components)."),
			color: z
				.string()
				.optional()
				.describe("Doc accent color as hex (e.g. '#9747FF'). Defaults to the Autodocs purple."),
			showBooleanVisibility: z
				.boolean()
				.optional()
				.default(false)
				.describe("Also document boolean-property visibility combinations (plugin 'generate-boolean')."),
			showNestedInstances: z
				.boolean()
				.optional()
				.default(false)
				.describe("Also document nested instance swaps (plugin 'generate-nested')."),
			fontFamily: z
				.string()
				.optional()
				.describe("Override the label font family (defaults to Inter)."),
			timeout: z
				.number()
				.optional()
				.default(60000)
				.describe("Execution timeout in ms (default 60000). Large variant sets take longer."),
		},
		async ({ nodeId, showGrid, color, showBooleanVisibility, showNestedInstances, fontFamily, timeout }) => {
			try {
				const opts: Record<string, unknown> = { showGrid, showBooleanVisibility, showNestedInstances };
				if (color) opts.color = color;
				if (fontFamily) opts.fontFamily = fontFamily;
				const code = buildGenerateScript(opts, nodeId);
				const connector = await getDesktopConnector();
				const result = await connector.executeCodeViaUI(code, Math.min(timeout, 120000));
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: result.success,
								result: result.result,
								error: result.error,
								fileContext: result.fileContext,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_generate_autodocs failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to generate autodocs",
								hint: "Make sure the Desktop Bridge plugin is running and a component set is selected (or pass nodeId).",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_remove_autodocs",
		`Remove Obra Autodocs documentation from a component set or component (mirrors the plugin's "Remove docs" command). Select the target or pass its nodeId.`,
		{
			nodeId: z
				.string()
				.optional()
				.describe("Component set / component node id. If omitted, uses the current selection."),
			timeout: z.number().optional().default(30000).describe("Execution timeout in ms (default 30000)."),
		},
		async ({ nodeId, timeout }) => {
			try {
				const code = buildRemoveScript(nodeId);
				const connector = await getDesktopConnector();
				const result = await connector.executeCodeViaUI(code, Math.min(timeout, 60000));
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: result.success,
								result: result.result,
								error: result.error,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_remove_autodocs failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to remove autodocs",
								hint: "Make sure the Desktop Bridge plugin is running and a component set is selected (or pass nodeId).",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
