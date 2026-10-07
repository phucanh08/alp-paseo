// The only public Paseo SDK import boundary. Target the installed desktop generation.
export {
  PROVIDER_PROTOCOL_VERSION, negotiateProviderCapabilities,
  requireProviderCapabilities, ProviderInputSchema, ProviderEventSchema,
} from '@getpaseo/plugin/server/provider';
export type {
  ProviderRegistration, ProviderConnection, ProviderInput, ProviderEvent,
  ProviderSessionConfig, ProviderPersistence, ProviderCatalog, ProviderTimelineItem,
} from '@getpaseo/plugin/server/provider';
export type { PluginServerContext } from '@getpaseo/plugin/server';
