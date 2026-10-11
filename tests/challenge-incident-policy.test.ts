import { describe, expect, it } from "vitest";
import {
  MANUAL_REMINDER_INTERVAL_MS,
  manualReminderKey,
  nextChallengeIncidentStatus,
  requiresManualChallengeVerification,
  shouldSendManualReminder,
} from "../apps/worker/src/modules/challenge-incident-policy.js";

describe("challenge incident policy", () => {
  it("records a first protection event as cooldown and a repeat explicitly", () => {
    expect(nextChallengeIncidentStatus({ manualVerificationRequired: false })).toBe("COOLDOWN");
    expect(nextChallengeIncidentStatus({
      activeStatus: "COOLDOWN",
      manualVerificationRequired: false,
    })).toBe("REPEATED");
  });

  it("requires human review after the third consecutive CAPTCHA response", () => {
    expect(requiresManualChallengeVerification({
      captchaDetected: true,
      priorConsecutiveErrors: 1,
    })).toBe(false);
    expect(requiresManualChallengeVerification({
      captchaDetected: true,
      priorConsecutiveErrors: 2,
    })).toBe(true);
  });

  it("does not classify a plain rate limit as CAPTCHA manual verification", () => {
    expect(requiresManualChallengeVerification({
      captchaDetected: false,
      priorConsecutiveErrors: 20,
    })).toBe(false);
  });

  it("keeps manual verification sticky until a successful recovery resolves it", () => {
    expect(nextChallengeIncidentStatus({
      activeStatus: "MANUAL_VERIFICATION_REQUIRED",
      manualVerificationRequired: false,
    })).toBe("MANUAL_VERIFICATION_REQUIRED");
  });

  it("reminds about stuck manual verification at most once per day", () => {
    expect(MANUAL_REMINDER_INTERVAL_MS).toBe(24 * 3_600_000);
    expect(manualReminderKey("source-1")).toBe("challenge:manual-reminder:source-1");
    expect(shouldSendManualReminder(null, Date.now())).toBe(true);
    expect(shouldSendManualReminder("not-a-date", Date.now())).toBe(true);
    expect(shouldSendManualReminder(new Date(Date.now() - 60 * 60 * 1000).toISOString(), Date.now())).toBe(false);
    expect(shouldSendManualReminder(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), Date.now())).toBe(true);
  });
});
