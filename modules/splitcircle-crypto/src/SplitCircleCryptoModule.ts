import { requireOptionalNativeModule } from 'expo';

export interface SplitCircleCryptoNativeModule {
  /** Phase 3 gate-2 spike only — returns base64(IdentityKeyPair.generate().serialize()). Not for real use. */
  spikeGenerateIdentityKeyPair(): Promise<string>;
}

export default requireOptionalNativeModule<SplitCircleCryptoNativeModule>('SplitCircleCrypto');
