export interface SmtpProviderDefaults {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
}

const providers: Readonly<Record<string, SmtpProviderDefaults>> = {
  'gmail.com': { host: 'smtp.gmail.com', port: 587, secure: false },
  'googlemail.com': { host: 'smtp.gmail.com', port: 587, secure: false },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
};

export function inferSmtpProviderDefaults(address: string | undefined): SmtpProviderDefaults | undefined {
  const domain = address?.trim().toLowerCase().split('@').at(-1);
  return domain === undefined ? undefined : providers[domain];
}
