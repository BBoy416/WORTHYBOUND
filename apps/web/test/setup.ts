import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node's object URLs do not accept jsdom's Blob.
URL.createObjectURL = () => "blob:test";
URL.revokeObjectURL = () => undefined;

afterEach(() => cleanup());
