// One-time: enable the Anonymous sign-in provider on the Firebase project so
// the app can obtain auth tokens required by the new security rules.
// Uses the service account (google-key.json) against the Identity Toolkit API.
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

(async () => {
  const auth = new GoogleAuth({
    keyFile: path.join(__dirname, '..', 'google-key.json'),
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const project = 'prasad-transport-grup';
  const res = await client.request({
    url: `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config?updateMask=signIn.anonymous.enabled`,
    method: 'PATCH',
    data: { signIn: { anonymous: { enabled: true } } },
  });
  console.log('Anonymous provider enabled:', JSON.stringify(res.data.signIn || {}));
})().catch(e => {
  console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message);
  process.exit(1);
});
