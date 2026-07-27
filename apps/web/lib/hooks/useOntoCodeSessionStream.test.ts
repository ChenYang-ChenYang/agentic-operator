import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  invalidateOntoCodeEvent,
  ontocodeStreamPath,
  parseOntoCodeSseFrame,
} from "./useOntoCodeSessionStream";

describe("OntoCode session stream helpers", () => {
  it("preserves the durable cursor across reconnects", () => {
    expect(ontocodeStreamPath("ocs-1")).toBe(
      "/v1/ontocode/sessions/ocs-1/stream",
    );
    expect(ontocodeStreamPath("ocs/unsafe", "17")).toBe(
      "/v1/ontocode/sessions/ocs%2Funsafe/stream?lastEventId=17",
    );
  });

  it("decodes multiline SSE data while ignoring heartbeats and retry hints", () => {
    expect(parseOntoCodeSseFrame(": heartbeat 1\nretry: 1000")).toBeNull();
    expect(
      parseOntoCodeSseFrame(
        'id: 17\nevent: message\ndata: {"part":1,\ndata: "ok":true}',
      ),
    ).toEqual({
      id: "17",
      event: "message",
      data: '{"part":1,\n"ok":true}',
    });
  });

  it("invalidates every live session projection", () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    invalidateOntoCodeEvent(
      { invalidateQueries } as unknown as QueryClient,
      "raas",
      "ocs-1",
    );
    expect(invalidateQueries).toHaveBeenCalledTimes(12);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "events"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [
        "ontocode",
        "raas",
        "session",
        "ocs-1",
        "configuration-tasks",
      ],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "jobs"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "artifacts"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "assistant-runs"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "candidate-head"],
    });
  });
});
