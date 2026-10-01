function normalizeSafetyText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export function claimsCompletedCloudAction(value: string): boolean {
  const sentences = normalizeSafetyText(value).split(/[.!?;\n]+/);
  const completedAction = /\b(?:ya\s+(?:apague|detuve|redimensione|modifique|cambie|ejecute|aplique)|(?:he|acabo\s+de)\s+(?:apagado|apagada|detenido|detenida|redimensionado|redimensionada|modificado|modificada|cambiado|ejecutado|aplicado|apagar|detener|redimensionar|modificar|cambiar|ejecutar|aplicar)|(?:cambio|accion)\s+(?:ya\s+)?(?:aplicado|ejecutado)|(?:instancia|recurso)\s+(?:ya\s+)?(?:quedo|esta|fue|ha\s+sido)\s+(?:apagado|apagada|detenido|detenida|redimensionado|redimensionada|modificado|modificada|cambiado|ejecutado|aplicado))\b/;
  const negatedAction = /\b(?:no|nunca|jamas)\s+(?:(?:ya|la|lo|el)\s+)?(?:(?:he|haya|habia)\s+)?(?:apague|detuve|redimensione|modifique|cambie|ejecute|aplique|apagado|apagada|detenido|detenida|redimensionado|redimensionada|modificado|modificada|cambiado|ejecutado|aplicado|apagar|detener|redimensionar|modificar|cambiar|ejecutar|aplicar)\b/;
  return sentences.some((sentence) => completedAction.test(sentence) && !negatedAction.test(sentence));
}

export function assertCloudActionClaimGuardSelfCheck(): true {
  const cases = [
    ['He redimensionado la instancia.', true],
    ['La instancia fue apagada.', true],
    ['No he apagado la instancia.', false],
    ['No he ejecutado cambios cloud.', false],
    ['No lo he apagado; puedo orientarte.', false],
    ['No puedo ejecutar cambios cloud desde el chat.', false],
  ] as const;
  if (!cases.every(([answer, expected]) => claimsCompletedCloudAction(answer) === expected)) {
    throw new Error('Cloud-action claim guard regression check failed.');
  }
  return true;
}
