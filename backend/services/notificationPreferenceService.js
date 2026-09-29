import prisma from '../lib/prisma.js';

export function isNotificationEnabled(preferences, eventKey, channel = 'email') {
  return preferences?.notifications?.[eventKey]?.[channel] !== false;
}

export async function enqueuePreferenceAwareNotification({
  eventKey,
  addresses,
  payload,
  notify,
  client = prisma,
}) {
  const uniqueAddresses = [...new Set((addresses || []).filter(Boolean))];
  const recipients = [];
  const skipped = [];

  for (const address of uniqueAddresses) {
    const [profile, user] = await Promise.all([
      client.userProfile.findUnique({
        where: { address },
        select: { preferences: true },
      }),
      client.user.findFirst({
        where: { walletAddress: address },
        select: { email: true },
      }),
    ]);

    if (!isNotificationEnabled(profile?.preferences, eventKey)) {
      skipped.push({ address, reason: 'preference_disabled' });
      continue;
    }

    if (!user?.email) {
      skipped.push({ address, reason: 'email_unavailable' });
      continue;
    }

    recipients.push({
      address,
      email: user.email,
    });
  }

  if (recipients.length === 0) {
    return {
      queued: 0,
      accepted: [],
      skipped,
    };
  }

  let send = notify;
  if (!send) {
    const { default: emailService } = await import('./emailService.js');
    send = emailService.notifyEscrowStatusChange;
  }

  const result = await send({
    ...payload,
    recipients,
  });

  return {
    ...result,
    skipped: [...skipped, ...(result.skipped || [])],
  };
}

export default {
  isNotificationEnabled,
  enqueuePreferenceAwareNotification,
};
