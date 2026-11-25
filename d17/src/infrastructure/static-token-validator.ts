import { createHash, timingSafeEqual } from "node:crypto";
import type { ITokenValidator } from "../presentation/mcp/token-validator.js";

export class StaticTokenValidator implements ITokenValidator {
  private readonly expected: Buffer;

  constructor(token: string) {
    this.expected = createHash("sha256").update(token).digest();
  }

  accepts(token: string): boolean {
    const supplied = createHash("sha256").update(token).digest();
    return timingSafeEqual(this.expected, supplied);
  }
}
