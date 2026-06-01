import type { TokenCandidate } from '../types';

export interface TokenSource {
  readonly name: string;
  fetchCandidates(): Promise<TokenCandidate[]>;
}
