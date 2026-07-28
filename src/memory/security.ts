export type MemorySecurityRisk = "SENSITIVE_MATERIAL_REJECTED" | "PROMPT_INJECTION_RISK_REJECTED";

const labelledSecretPattern = /(?:authorization\s*[:=]\s*(?:bearer\s+)?\S{8,}|(?:api[_-]?key|api密钥|密码|口令|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|access[_-]?key|secret[_-]?key|refresh[_-]?token)\s*["']?\s*[:=：]\s*["']?\S{8,}|-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----)/iu;
const providerSecretPattern = /(?:\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bxox[baprs]-[0-9A-Za-z-]{20,}\b)/u;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u;
const credentialDsnPattern = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^\s:/@]+:[^\s/@]{4,}@[^\s]+/iu;
const injectionPattern = /(?:ignore\s+(?:all\s+)?previous\s+(?:system\s+|developer\s+)?instructions|reveal\s+(?:the\s+)?system\s+prompt|you\s+are\s+now\s+(?:the\s+)?system|<\/?(?:system|developer|assistant|tool)(?:\s[^>]*)?>|\\?["']role\\?["']\s*:\s*\\?["'](?:system|developer|tool)\\?["']|(?:^|\n)\s*(?:system|developer)\s*:\s*|\[INST\]|<<SYS>>|override\s+(?:the\s+)?(?:system|developer)\s+(?:message|instructions?)|忽略(?:此前|之前|以上)?(?:的)?(?:所有)?(?:系统|开发者|用户)?(?:指令|消息|规则)|(?:泄露|显示|输出|复述)(?:系统|开发者)(?:提示词|消息|指令)|(?:覆盖|绕过|取代)(?:系统|开发者)(?:提示词|指令|规则)|你现在是(?:系统|开发者)|把以下内容当作(?:系统|开发者)(?:指令|消息))/imu;

export function classifyMemorySecurityRisk(value: string): MemorySecurityRisk | null {
  const securityText = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const compact = securityText.replace(/[\s._·•:：'"`\\/-]+/gu, "");
  if (labelledSecretPattern.test(securityText) || providerSecretPattern.test(securityText)
    || jwtPattern.test(securityText) || credentialDsnPattern.test(securityText)) {
    return "SENSITIVE_MATERIAL_REJECTED";
  }
  if (injectionPattern.test(securityText)
    || /忽略(?:此前|之前|以上)?(?:的)?(?:所有)?(?:系统|开发者)?(?:指令|消息|规则)/u.test(compact)
    || /(?:泄露|显示|输出|复述)(?:系统|开发者)(?:提示词|消息|指令)/u.test(compact)) {
    return "PROMPT_INJECTION_RISK_REJECTED";
  }
  return null;
}
