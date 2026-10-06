export interface SmtpProviderDefaults {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
}

const googleWorkspaceDefaults: SmtpProviderDefaults = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
};

const providers: Readonly<Record<string, SmtpProviderDefaults>> = {
  'gmail.com': { host: 'smtp.gmail.com', port: 587, secure: false },
  'googlemail.com': { host: 'smtp.gmail.com', port: 587, secure: false },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
};

export function resolveSmtpProviderDefaults(address: string | undefined): SmtpProviderDefaults | undefined {
  const domain = address?.trim().toLowerCase().split('@').at(-1);
  if (domain === undefined) return undefined;
  return providers[domain] ?? googleWorkspaceDefaults;
}
