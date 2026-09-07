import { loadConfig } from '@gerald/config';
import { createApi, defaultIdentity } from './app.js';
import {
  EmailWebhookProcessor,
  InMemoryWebhookReceiptStore,
  ResendClient,
  ResendDeliveryProcessor,
  ResendWebhookVerifier,
} from '@gerald/email';
import {
  GoogleOAuthService,
  GooglePubSubVerifier,
  GoogleTokenVault,
  InMemoryGoogleAccountStore,
} from '@gerald/google';
import { SecretCipher } from '@gerald/security';

const config = loadConfig();
const identity = defaultIdentity(config);
const resendReceipts = new InMemoryWebhookReceiptStore();
const resendVerifier = config.resend.webhookSecret
  ? new ResendWebhookVerifier(config.resend.webhookSecret)
  : undefined;
const emailProcessor = resendVerifier
  ? new EmailWebhookProcessor(
      resendVerifier,
      resendReceipts,
      identity.authorizedEmails,
      config.resend.assistantEmail,
    )
  : undefined;
const deliveryProcessor = resendVerifier
  ? new ResendDeliveryProcessor(resendVerifier, resendReceipts)
  : undefined;
const resendClient = config.resend.apiKey ? new ResendClient(config.resend.apiKey) : undefined;
const googleOAuth =
  config.google.clientId && config.google.clientSecret
    ? new GoogleOAuthService({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri: config.google.redirectUri,
      })
    : undefined;
const googleTokenVault = config.masterKeyBase64
  ? new GoogleTokenVault(new SecretCipher(config.masterKeyBase64))
  : undefined;
const googleAccounts = new InMemoryGoogleAccountStore();
const googlePubSub = config.google.pubSubAudience
  ? new GooglePubSubVerifier(config.google.pubSubAudience, async () => config.env !== 'production')
  : undefined;
const app = await createApi({
  config,
  identity,
  googleAccounts,
  ...(emailProcessor ? { emailProcessor } : {}),
  ...(deliveryProcessor ? { deliveryProcessor } : {}),
  ...(resendClient ? { resendClient } : {}),
  ...(googleOAuth ? { googleOAuth } : {}),
  ...(googleTokenVault ? { googleTokenVault } : {}),
  ...(googlePubSub ? { googlePubSub } : {}),
});
await app.listen({ host: '0.0.0.0', port: config.port });
