/**
 * src/auth-oauth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OAuth 소셜 로그인 (Google, GitHub)
 *
 * 지원 전략:
 *   - Google OAuth 2.0  (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
 *   - GitHub OAuth 2.0  (GITHUB_CLIENT_ID  / GITHUB_CLIENT_SECRET)
 *
 * 환경 변수가 없으면 전략 등록을 건너뛰고 /api/auth/oauth/status에서 알림.
 *
 * 사용 흐름:
 *   GET /api/auth/google          → Google 로그인 리다이렉트
 *   GET /api/auth/google/callback → 콜백 → 토큰 발급 → 클라이언트로 리다이렉트
 *   GET /api/auth/github          → GitHub 로그인 리다이렉트
 *   GET /api/auth/github/callback → 콜백 → 토큰 발급 → 클라이언트로 리다이렉트
 *   GET /api/auth/oauth/status    → 어떤 OAuth가 설정됐는지 확인
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const crypto         = require('crypto');

// ─── 토큰 생성 (src/auth.js 방식과 동일) ─────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ─── OAuth 전략 등록 ─────────────────────────────────────────────────────────

/**
 * Passport 전략을 초기화합니다.
 * db 파라미터: { getUserByEmail, upsertOAuthUser, insertToken }
 *
 * @param {{ getUserByEmail, upsertOAuthUser, insertToken }} db
 * @returns {{ passport, enabledProviders: string[] }}
 */
function initOAuthStrategies(db) {
  const enabledProviders = [];

  // ── Google ──────────────────────────────────────────────────────────────────
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy(
      {
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  process.env.OAUTH_CALLBACK_BASE
          ? `${process.env.OAUTH_CALLBACK_BASE}/api/auth/google/callback`
          : '/api/auth/google/callback',
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || `google_${profile.id}@oauth.local`;
          const user  = await db.upsertOAuthUser({
            provider:    'google',
            providerId:  profile.id,
            email,
            name:        profile.displayName || email.split('@')[0],
            avatar:      profile.photos?.[0]?.value || null,
          });
          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    ));
    enabledProviders.push('google');
  }

  // ── GitHub ───────────────────────────────────────────────────────────────────
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy(
      {
        clientID:     process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL:  process.env.OAUTH_CALLBACK_BASE
          ? `${process.env.OAUTH_CALLBACK_BASE}/api/auth/github/callback`
          : '/api/auth/github/callback',
        scope: ['user:email'],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || `github_${profile.id}@oauth.local`;
          const user  = await db.upsertOAuthUser({
            provider:    'github',
            providerId:  profile.id,
            email,
            name:        profile.displayName || profile.username || email.split('@')[0],
            avatar:      profile.photos?.[0]?.value || null,
          });
          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    ));
    enabledProviders.push('github');
  }

  // Passport 세션 직렬화 (userId만 저장)
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await db.getUserById(id);
      done(null, user || false);
    } catch (err) {
      done(err);
    }
  });

  return { passport, enabledProviders };
}

// ─── 라우터 팩토리 ─────────────────────────────────────────────────────────────

/**
 * OAuth 라우터를 생성합니다.
 *
 * @param {{ passport, enabledProviders, insertToken, CLIENT_ORIGIN }} deps
 * @returns {express.Router}
 */
function createOAuthRouter({ passport, enabledProviders, insertToken, CLIENT_ORIGIN }) {
  const express = require('express');
  const router  = express.Router();

  const origin = CLIENT_ORIGIN || process.env.CLIENT_ORIGIN || 'http://localhost:4747';

  // ── OAuth 설정 상태 확인 ────────────────────────────────────────────────────
  router.get('/oauth/status', (_req, res) => {
    res.json({
      enabledProviders,
      google: enabledProviders.includes('google'),
      github: enabledProviders.includes('github'),
    });
  });

  // ── Google 로그인 ───────────────────────────────────────────────────────────
  if (enabledProviders.includes('google')) {
    router.get('/google',
      passport.authenticate('google', { scope: ['profile', 'email'], session: false })
    );

    router.get('/google/callback',
      passport.authenticate('google', { session: false, failureRedirect: `${origin}/?oauth_error=google_failed` }),
      async (req, res) => {
        const token = generateToken();
        await insertToken(req.user.id, token);
        // 토큰을 URL 프래그먼트로 전달 (서버 로그에 남지 않음)
        res.redirect(`${origin}/?oauth_token=${token}&provider=google`);
      }
    );
  } else {
    router.get('/google', (_req, res) =>
      res.status(501).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' })
    );
  }

  // ── GitHub 로그인 ───────────────────────────────────────────────────────────
  if (enabledProviders.includes('github')) {
    router.get('/github',
      passport.authenticate('github', { scope: ['user:email'], session: false })
    );

    router.get('/github/callback',
      passport.authenticate('github', { session: false, failureRedirect: `${origin}/?oauth_error=github_failed` }),
      async (req, res) => {
        const token = generateToken();
        await insertToken(req.user.id, token);
        res.redirect(`${origin}/?oauth_token=${token}&provider=github`);
      }
    );
  } else {
    router.get('/github', (_req, res) =>
      res.status(501).json({ error: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.' })
    );
  }

  return router;
}

module.exports = { initOAuthStrategies, createOAuthRouter, generateToken };
