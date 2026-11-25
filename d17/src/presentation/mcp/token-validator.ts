export interface ITokenValidator {
  accepts(token: string): boolean;
}
