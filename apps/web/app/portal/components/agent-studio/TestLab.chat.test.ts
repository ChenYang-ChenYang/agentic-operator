import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "TestLab.tsx"), "utf8");
const hooks = readFileSync(
  resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "lib",
    "hooks",
    "useAgentStudio.ts",
  ),
  "utf8",
);
const css = readFileSync(
  resolve(__dirname, "..", "..", "..", "global.css"),
  "utf8",
);

describe("Test Lab chat wiring", () => {
  it("opens on the chat result and loads a pollable run session", () => {
    expect(source).toContain('useState<ResultTab>("chat")');
    expect(source).toContain("useRunSession(sessionId)");
    expect(source).toContain('role="log"');
    expect(hooks).toContain("GetRunSessionResponseSchema.parse");
    expect(hooks).toContain("AGENT_STUDIO_KEYS.session(sessionId)");
    expect(hooks).toMatch(/refetchInterval:[\s\S]{0,320}run\.status/);
  });

  it("sends exact composer text with explicit session context", () => {
    expect(source).toContain('const [prompt, setPrompt] = useState("")');
    expect(source).not.toContain("String(promptInput?.default");
    expect(source).toContain("const submittedPrompt = prompt");
    expect(source).toContain("buildStudioChatRunRequest({");
    expect(source).toContain("prompt: submittedPrompt");
    expect(hooks).toContain("CreateAgentRunBodySchema.parse(body)");
    expect(hooks).toContain("`/v1/agents/${encodeURIComponent(agentId)}/runs`");
    expect(hooks).toContain("body: JSON.stringify(payload)");
    expect(source.indexOf('setPrompt("")')).toBeGreaterThan(
      source.indexOf("await createRun.mutateAsync"),
    );
    expect(source).toMatch(
      /event\.key === "Enter"[\s\S]{0,100}!event\.shiftKey[\s\S]{0,220}void run\(\)/,
    );
  });

  it("guards click/key races so one message dispatches one event", () => {
    expect(source).toContain("dispatchInFlightRef");
    expect(source).toContain(
      "if (submitDisabled || dispatchInFlightRef.current) return",
    );
    const acquired = source.indexOf("dispatchInFlightRef.current = true");
    const finallyBlock = source.indexOf("finally {", acquired);
    const released = source.indexOf(
      "dispatchInFlightRef.current = false",
      finallyBlock,
    );
    expect(acquired).toBeGreaterThan(-1);
    expect(finallyBlock).toBeGreaterThan(acquired);
    expect(released).toBeGreaterThan(finallyBlock);
  });

  it("refreshes run history even when dispatch fails after reservation", () => {
    expect(hooks).toContain("onSettled: async (response)");
    expect(hooks).toContain('["agent-studio", "history", agentId]');
  });

  it("shows the queued event immediately and correlates it to the returned run", () => {
    expect(source).toContain('state: "publishing"');
    expect(source).toContain('state: "queued"');
    expect(source).toContain("runId: response.runId");
    expect(source).toContain("eventId: response.eventId");
    expect(source).toContain("eventName: response.eventName");
    expect(source).toContain('studioUi(t, "event")');
    expect(source).toContain("{lastDispatch.eventName}");
    expect(source).toContain("events?eventId=");
    expect(source).toContain(
      "Publishing the trigger event to the agent runtime…",
    );
    expect(source).toContain('studioUi(t, "The trigger event")');
  });

  it("pins the target for a conversation and makes New chat reset it", () => {
    expect(source).toContain("conversationTarget");
    expect(source).toContain("setConversationTarget(requestedTarget)");
    expect(source).toContain("session.data?.continuation");
    expect(source).toContain("setConversationTarget(continuation.target)");
    expect(source).toContain(
      "setConversationTriggerEvent(continuation.triggerEvent)",
    );
    expect(source).toContain("setInputs(continuation.inputs)");
    expect(source).toMatch(
      /function newChat\(\)[\s\S]{0,240}setConversationTarget\(null\)/,
    );
    expect(source).toContain("Start a new chat to change it.");
  });

  it("selects an authored trigger once and pins it for follow-ups", () => {
    expect(source).toContain('label={studioUi(t, "Trigger event")}');
    expect(source).toContain("definition.trigger[0]");
    expect(source).toContain("requestedTriggerEvent");
    expect(source).toContain("triggerEvent: requestedTriggerEvent");
    expect(source).toContain("setConversationTriggerEvent(response.eventName)");
    expect(source).toMatch(
      /function newChat\(\)[\s\S]{0,320}setConversationTriggerEvent\(undefined\)/,
    );
  });


  it("responds to the available Test Lab panel width without horizontal form overflow", () => {
    expect(source).toContain('className="agent-studio-test-lab"');
    expect(source).toContain("testHistoryFitsInline(nextWidth)");
    expect(source).not.toContain("setHistoryInline(window.innerWidth > 1_280)");
    expect(source).toContain(
      "agent-studio-test-runtime-grid agent-studio-test-runtime-grid--pair",
    );
    expect(source).toContain(
      "agent-studio-test-runtime-grid agent-studio-test-runtime-grid--numeric",
    );
    expect(source).toContain('className="agent-studio-test-advanced"');
    expect(source).toContain('className="agent-studio-test-advanced-body"');
    expect(css).toContain("container: agent-studio-test / inline-size");
    expect(css).toContain("container: agent-studio-test-setup / inline-size");
    expect(css).toMatch(
      /@container agent-studio-test \(max-width: 1100px\)[\s\S]*?\.agent-studio-test-history[\s\S]*?position: absolute/,
    );
    expect(css).toMatch(
      /@container agent-studio-test \(max-width: 720px\)[\s\S]*?\.agent-studio-test-grid[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(css).toMatch(
      /\.agent-studio-test-runtime-grid\s*\{[\s\S]*?repeat\([\s\S]*?auto-fit[\s\S]*?minmax\(min\(220px, 100%\), 1fr\)/,
    );
    expect(css).toMatch(
      /@container agent-studio-test-setup \(max-width: 520px\)[\s\S]*?\.agent-studio-test-runtime-grid[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(css).toMatch(
      /\.agent-studio-test-setup-body\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)[\s\S]*?overflow: auto !important/,
    );
    expect(css).toContain(".agent-studio-test-setup-body > *");
    expect(css).toMatch(
      /\.agent-studio-control\s*\{[\s\S]*?min-width: 0[\s\S]*?max-width: 100%/,
    );
  });

  it("renders response text in chat while retaining ambiguous structured JSON", () => {
    expect(source).toContain("assistantTextFromValue");
    expect(source).toContain("textOutputKeys={textOutputKeys}");
    expect(source).toContain(
      'assistantText != null ? (\n          <div className="agent-studio-chat-text">{assistantText}</div>',
    );
    expect(source).toContain("isStructuredChatValue(message.content)");
    expect(source).toContain('<pre className="agent-studio-chat-json">');
  });

  it("keeps the complete selected-run JSON in a collapsed output textarea", () => {
    expect(source).toContain(
      '<details className="agent-studio-output-details">',
    );
    expect(source).not.toContain(
      '<details open className="agent-studio-output-details">',
    );
    expect(source).toContain(
      'aria-label={studioUi(t, "Selected run JSON output")}',
    );
    expect(source).toContain("readOnly");
    expect(source).toContain("value={selectedOutputText}");
    expect(source).toContain("prettyJsonOutput(output.data.output)");
    expect(css).toContain(".agent-studio-output-details textarea");
  });



  it("replaces the runtime banner with an accessible hover/focus hint", () => {
    expect(source).toContain("function RuntimeHint()");
    expect(source).toContain(
      'aria-label={studioUi(t, "How Test Lab runs are executed")}',
    );
    expect(source).toContain('role="tooltip"');
    expect(source).toContain('<Icon name="info"');
    // The hint REPLACES the standing banner — both would be duplicate copy.
    expect(source).not.toContain(
      'title={studioUi(t, "Test Lab uses the real runtime")}',
    );
    expect(css).toContain(".agent-studio-runtime-hint:hover");
    expect(css).toContain(".agent-studio-runtime-hint:focus-within");
  });

  it("keeps live execution steps, tokens, and exact cost in the chat view", () => {
    expect(source).toContain("function RunProgressCard(");
    expect(source).toContain("useRun(selectedRunId");
    expect(source).toContain("detail?.usage");
    expect(source).toContain("usage.costUsdNanos");
    expect(source).toContain("formatUsdNanos");
    expect(source).toContain("compactProgressEvents(traceEvents)");
    expect(source).toContain("Open full trace");
    expect(source).toContain("<RunProgressCard");
    expect(css).toContain(".agent-studio-run-progress__metrics");
    expect(css).toContain(".agent-studio-run-progress__timeline");
    expect(hooks).toContain("GetRunSessionResponseSchema.parse");
  });

  it("shows the authored emitted events beside the trigger event setting", () => {
    expect(source).toContain("definition.triggered_event");
    expect(source).toContain("new Set(");
    expect(source).toContain('aria-label={studioUi(t, "Emitted events")}');
    expect(source).toContain("emittedEvents.map");
    expect(source).toContain("Configured outgoing events.");
    expect(source).toContain("title={name}");
    expect(source).toContain("No emitted events configured");
    expect(source).toContain('role="status"');
    expect(css).toContain(".agent-studio-test-event-list");
    expect(css).toContain(".agent-studio-test-event-chip");
  });

  it("loads models for the effective provider and prevents stale provider/model pairs", () => {
    expect(source).toContain("useAvailableModels(effectiveProvider)");
    expect(source).toContain("providerModelIds(");
    expect(source).toContain("testModelOptions({");
    expect(source).toContain("providerOverrideNeedsModel(provider, model)");
    expect(source).toContain(
      "numericRuntimeOverridesInvalid || providerModelMissing",
    );
    expect(source).toContain("onChange={changeProvider}");
    expect(source).toContain("onChange={changeCatalogModel}");
    expect(source).toContain('setModel("")');
    expect(source).toContain("setManualModelEntry(false)");
    expect(source).toContain("clearModelSpecificOverrides()");
    expect(source).toContain('setStoreResponse("")');
    expect(source).toContain("onChange={changeManualModel}");
    expect(source).toContain("CUSTOM_MODEL_OPTION");
    expect(source).not.toContain(
      'label="Temporary AI model"\\n                    hint="Only changes this test run.',
    );
  });

  it("omits unsupported temperature defaults and clears stale model overrides", () => {
    expect(source).toContain("temperatureRange:");
    expect(source).toContain(
      "const temperatureUnsupported = modelCapabilities.temperatureRange === null",
    );
    expect(source).toContain('setTemperature("")');
    expect(source).toContain("!temperatureUnsupported &&");
    expect(source).toContain(
      "The saved agent setting is omitted for this test.",
    );
    expect(source).toContain("disabled={temperatureUnsupported}");
    expect(source).toContain('"Not supported — omitted"');
  });
});
