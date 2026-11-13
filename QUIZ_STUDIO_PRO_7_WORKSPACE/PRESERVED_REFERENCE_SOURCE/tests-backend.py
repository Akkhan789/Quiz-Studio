"""Backend integration smoke tests; uses a fake Edge TTS adapter for deterministic tests."""
import os, sys, types, tempfile, unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ['QSP_DB_PATH'] = str(Path(TMP.name) / 'test.sqlite3')
os.environ['QSP_JWT_SECRET'] = 'unit-test-jwt-secret-that-is-at-least-32-bytes-long'
os.environ['QSP_BOOTSTRAP_SECRET'] = 'unit-test-bootstrap-secret'
os.environ['QSP_REGISTRATION_CODE'] = 'unit-test-invite'

fake = types.ModuleType('edge_tts')
async def list_voices():
    return [{'ShortName':'en-US-TestVoice','FriendlyName':'Test Voice','Gender':'Female','Locale':'en-US'}]
class Communicate:
    def __init__(self, *args, **kwargs): pass
    async def save(self, path): Path(path).write_bytes(b'ID3' + b'x' * 512)
fake.list_voices = list_voices
fake.Communicate = Communicate
sys.modules['edge_tts'] = fake
sys.path.insert(0, str(Path(__file__).parent / 'tts-backend'))
import server
from fastapi.testclient import TestClient

class BackendSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.client = TestClient(server.app)
    def test_full_account_and_tts_smoke(self):
        c = self.client
        r = c.post('/admin/bootstrap', json={'bootstrapSecret':os.environ['QSP_BOOTSTRAP_SECRET'],'username':'admin','password':'Strong-admin-password-123'})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post('/account/login', json={'username':'admin','password':'Strong-admin-password-123','deviceId':'admin-console','deviceName':'Console'})
        self.assertEqual(r.status_code, 200, r.text); admin = r.json()['token']
        ah = {'Authorization':'Bearer '+admin,'X-Device-ID':'admin-console'}
        r = c.post('/admin/users', headers=ah, json={'username':'member','password':'Strong-member-password-123','plan':'Trial','expiresAt':None})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post('/account/login', json={'username':'member','password':'Strong-member-password-123','deviceId':'device-a','deviceName':'Phone A'})
        self.assertEqual(r.status_code, 200, r.text); member = r.json()['token']
        mh = {'Authorization':'Bearer '+member,'X-Device-ID':'device-a'}
        self.assertEqual(c.post('/account/validate', headers=mh).status_code, 200)
        self.assertEqual(c.post('/account/validate', headers={**mh,'X-Device-ID':'device-b'}).status_code, 403)
        self.assertEqual(c.patch('/admin/users/2', headers=ah, json={'resetDevice':True}).status_code, 200)
        r = c.post('/account/login', json={'username':'member','password':'Strong-member-password-123','deviceId':'device-b','deviceName':'Phone B'})
        self.assertEqual(r.status_code, 200, r.text); member2 = r.json()['token']
        r = c.post('/account/change-password', headers={'Authorization':'Bearer '+member2}, json={'oldPassword':'Strong-member-password-123','newPassword':'Even-stronger-member-password-456','deviceId':'device-b'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(c.post('/account/validate', headers={'Authorization':'Bearer '+member2,'X-Device-ID':'device-b'}).status_code, 401)
        r = c.post('/account/login', json={'username':'member','password':'Even-stronger-member-password-456','deviceId':'device-b','deviceName':'Phone B'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(c.get('/api/health').json()['engines']['edge']['available'])
        self.assertEqual(c.get('/api/voices').json()['voices'][0]['id'], 'en-US-TestVoice')
        self.assertEqual(c.post('/api/tts', json={'text':'hello','voice':'en-US-TestVoice','speed':1.0,'engine':'edge'}).status_code, 200)

if __name__ == '__main__':
    unittest.main(verbosity=2)
