export interface MessagingPreference {
  readonly id: string;
  readonly userId: string;
  readonly emailEnabled: boolean;
  readonly telegramEnabled: boolean;
  readonly operationalAlerts: boolean;
  readonly recommendationAlerts: boolean;
  readonly financialAlerts: boolean;
  readonly executiveSummaries: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type MessagingPreferenceUpdate = Partial<Pick<
  MessagingPreference,
  | 'emailEnabled'
  | 'telegramEnabled'
  | 'operationalAlerts'
  | 'recommendationAlerts'
  | 'financialAlerts'
  | 'executiveSummaries'
>>;
