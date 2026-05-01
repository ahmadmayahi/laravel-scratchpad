import { describe, expect, it } from "vitest";
import { scratchFileUri } from "./uri";

describe("scratchFileUri", () => {
    it("produces a stable file:// URI for a Unix project path", () => {
        const uri = scratchFileUri("/home/user/myapp", "abc-123");
        expect(uri).toBe("file:///home/user/myapp/.laravel-scratchpad/tab-abc-123.php");
    });

    it("normalises Windows backslashes to forward slashes", () => {
        const uri = scratchFileUri("C:\\Users\\Ahmad\\Sites\\app", "tab-1");
        // Each segment is percent-encoded; the colon after C is an
        // intentionally encoded path separator.
        expect(uri).toBe("file:///C%3A/Users/Ahmad/Sites/app/.laravel-scratchpad/tab-tab-1.php");
    });

    it("strips trailing slashes from the project path so paths don't end up doubled", () => {
        expect(scratchFileUri("/foo/bar/", "x")).toBe("file:///foo/bar/.laravel-scratchpad/tab-x.php");
        expect(scratchFileUri("/foo/bar///", "x")).toBe("file:///foo/bar/.laravel-scratchpad/tab-x.php");
    });

    it("percent-encodes spaces and unicode so the URI stays parseable", () => {
        const uri = scratchFileUri("/Users/Ahmad/My Documents/Café", "tab");
        expect(uri).toBe("file:///Users/Ahmad/My%20Documents/Caf%C3%A9/.laravel-scratchpad/tab-tab.php");
    });
});
