/**
 * GitHub OAuth and API Types
 */

/** GitHub OAuth token response */
export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

/** GitHub user info */
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
  html_url: string;
  bio: string | null;
  public_repos: number;
  followers: number;
  following: number;
}

/** GitHub repository */
export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  private: boolean;
  fork: boolean;
  owner: {
    login: string;
    avatar_url: string;
  };
  updated_at: string;
  pushed_at: string;
  default_branch: string;
}

/** Stored GitHub credential */
export interface GitHubCredential {
  id: string;
  access_token: string;
  token_type: string;
  scope: string;
  user_login: string;
  user_name: string | null;
  avatar_url: string;
  created_at: string;
  updated_at: string;
}

/** GitHub OAuth state (for CSRF protection) */
export interface GitHubOAuthState {
  state: string;
  redirect_uri: string;
  created_at: number;
}
