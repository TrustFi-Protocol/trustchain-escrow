import ReputationBadge from '../../../components/ui/ReputationBadge';
import Badge from '../../../components/ui/Badge';
import TruncatedAddress from '../../../components/ui/TruncatedAddress';
import Button from '../../../components/ui/Button';

async function getProfile(address) {
  try {
    const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const res = await fetch(`${base}/api/users/${address}`, { next: { revalidate: 10 } });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function StatBlock({ label, value }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div>
      <p className="text-gray-500">{label}</p>
      <p className="text-white font-semibold">{value}</p>
    </div>
  );
}

export default async function ProfilePage({ params }) {
  const { address } = params;
  const profile = await getProfile(address);

  if (!profile || Object.keys(profile).length === 0) {
    return (
      <div className="card max-w-3xl mx-auto text-center space-y-3">
        <h1 className="text-xl font-bold text-white font-mono">
          <TruncatedAddress address={address} />
        </h1>
        <p className="text-gray-400">No profile data is available for this address yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl mx-auto">
      <div className="card flex flex-col sm:flex-row gap-6 items-start">
        <div className="w-16 h-16 rounded-2xl bg-indigo-600/30 flex items-center justify-center text-indigo-300 font-bold text-xl flex-shrink-0">
          {address.slice(1, 3)}
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-white font-mono">
              <TruncatedAddress address={address} />
            </h1>
            {profile.badge && <Badge status={profile.badge} />}
          </div>

          {profile.bio && <p className="text-gray-300 mt-2">{profile.bio}</p>}
          {profile.memberSince && (
            <p className="text-gray-500 text-sm mt-1">Member since {profile.memberSince}</p>
          )}

          <div className="flex gap-6 mt-4 text-sm flex-wrap">
            <StatBlock label="Completed" value={profile.completedEscrows} />
            <StatBlock label="Disputed" value={profile.disputedEscrows} />
            <StatBlock label="Volume" value={profile.totalVolume} />
            <StatBlock
              label="Completion Rate"
              value={
                profile.completionRate !== undefined && profile.completionRate !== null
                  ? `${profile.completionRate}%`
                  : undefined
              }
            />
          </div>
        </div>

        {profile.reputationScore !== undefined && (
          <div className="text-center">
            <ReputationBadge score={profile.reputationScore} size="lg" />
            <p className="text-xs text-gray-500 mt-1">Reputation Score</p>
            <div className="mt-3">
              <Button variant="secondary" size="sm">
                Share Profile
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
