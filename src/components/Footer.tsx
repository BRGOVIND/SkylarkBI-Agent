import AgentMark from './AgentMark';

/**
 * Closes the page. Deliberately quiet — it should not compete with the agent.
 *
 * Links are the project's real ones, taken from the git remote. No portfolio
 * URL exists anywhere in this repository, so none is invented here; add one to
 * PROFILE_URL if that changes.
 */

const REPO_URL = 'https://github.com/BRGOVIND/SkylarkBI-Agent';
const PROFILE_URL = 'https://github.com/BRGOVIND';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-id">
          <AgentMark size={20} />
          <div>
            <div className="footer-name">Skylark BI Agent</div>
            <div className="footer-tag">Business intelligence grounded in live data</div>
          </div>
        </div>

        <nav className="footer-links" aria-label="Project links">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href={PROFILE_URL} target="_blank" rel="noopener noreferrer">
            Developer
          </a>
        </nav>
      </div>

      <div className="footer-rule" />
      <p className="footer-note">Skylark Drones Assessment</p>
    </footer>
  );
}
