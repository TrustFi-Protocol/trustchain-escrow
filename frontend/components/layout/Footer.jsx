/**
 * Footer Component
 */
export default function Footer() {
  const contractAddress = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS?.trim();
  const network = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'testnet').toLowerCase();
  const expertNetwork = network === 'public' || network === 'mainnet' ? 'public' : 'testnet';
  const contractUrl = contractAddress
    ? `https://stellar.expert/explorer/${expertNetwork}/contract/${contractAddress}`
    : null;

  return (
    <footer className="border-t border-gray-800 py-6 mt-12">
      <div className="container mx-auto px-4 max-w-7xl flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-gray-500">
        <p>© 2025 StellarTrustEscrow — MIT License</p>
        <div className="flex gap-4 items-center flex-wrap justify-center">
          <a
            href="https://github.com/TrustFi-Protocol/trustchain-escrow"
            className="hover:text-white transition-colors"
          >
            GitHub
          </a>
          <a href="/docs" className="hover:text-white transition-colors">
            Docs
          </a>
          {contractUrl && (
            <a href={contractUrl} className="hover:text-white transition-colors font-mono text-xs">
              {contractAddress}
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
