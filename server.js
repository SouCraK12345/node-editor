const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const port = 1248;

app.use(express.json());
app.use(express.static('./'));

const WORKSPACE_DIR = path.join(__dirname, process.argv[2] || 'workspace');

if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

function resolveSafePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return null;
  const normalizedPath = targetPath.split('/').join(path.sep);
  const absolutePath = path.resolve(WORKSPACE_DIR, normalizedPath);
  const relativePath = path.relative(WORKSPACE_DIR, absolutePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return absolutePath;
}

// サブフォルダも含めて再帰的にファイル一覧を取得する関数
function getFilesRecursive(dir, baseDir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // フォルダならさらに中身を検索
      getFilesRecursive(filePath, baseDir, fileList);
    } else {
      // ファイルなら、ベースディレクトリからの相対パスを取得
      const relativePath = path.relative(baseDir, filePath);
      // Windows環境でもフロントエンドで扱いやすいようにパス区切りを '/' に統一
      fileList.push(relativePath.split(path.sep).join('/'));
    }
  }
  return fileList;
}

// 1. ファイル一覧取得 API
app.get('/api/files', (req, res) => {
  try {
    const fileList = getFilesRecursive(WORKSPACE_DIR, WORKSPACE_DIR);
    res.json(fileList);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// 2. ファイル読み込み API (クエリパラメータ: ?path=... を使用)
app.get('/api/file', (req, res) => {
  const absolutePath = resolveSafePath(req.query.path);
  if (!absolutePath) {
    return res.status(400).send('Invalid filename');
  }

  try {
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      res.send(content);
    } else {
      res.status(404).send('File not found');
    }
  } catch (error) {
    res.status(500).send('Error reading file');
  }
});

// 3. ファイル保存 API (クエリパラメータ: ?path=... を使用)
app.post('/api/file', (req, res) => {
  const absolutePath = resolveSafePath(req.query.path);
  if (!absolutePath) {
    return res.status(400).send('Invalid filename');
  }
  const content = req.body.content || '';

  try {
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(absolutePath, content, 'utf-8');
    res.send('Saved successfully');
  } catch (error) {
    res.status(500).send('Failed to save file');
  }
});

app.post('/api/create', (req, res) => {
  const { path: targetPath, type } = req.body || {};
  const absolutePath = resolveSafePath(targetPath);

  if (!absolutePath || !['file', 'folder'].includes(type)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    if (fs.existsSync(absolutePath)) {
      return res.status(409).json({ error: 'Path already exists' });
    }

    if (type === 'folder') {
      fs.mkdirSync(absolutePath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, '', 'utf-8');
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create item' });
  }
});

app.post('/api/delete', (req, res) => {
  const { path: targetPath } = req.body || {};
  const absolutePath = resolveSafePath(targetPath);

  if (!absolutePath) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    fs.rmSync(absolutePath, { recursive: true, force: false });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

app.post("/api/github-auth", async (req, res) => {
  const token = req.body.code;
  try {
    const child = spawn('gh', ['auth', 'login', '--with-token'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let errorData = '';
    child.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    child.stdin.end(token);

    child.on('close', (code) => {
      if (code === 0) {
        res.json({ success: true });
      } else {
        res.status(500).json({ success: false, error: errorData || 'gh exited with code ' + code });
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/github-clone", async (req, res) => {
  const repoUrl = req.body.repoUrl;
  console.log(repoUrl);
  try {
    const child = spawn('gh', ['repo', 'clone', repoUrl, WORKSPACE_DIR], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let errorData = '';
    child.stderr.on('data', (data) => {
      errorData += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        res.json({ success: true });
      } else {
        res.status(500).json({ success: false, error: errorData || 'gh exited with code ' + code });
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/github-pull", async (req, res) => {
  try {
    const child = spawn('git', ['pull'], {
      cwd: WORKSPACE_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let errorData = '';
    child.stderr.on('data', (data) => {
      errorData += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        res.json({ success: true });
      } else {
        res.status(500).json({ success: false, error: errorData || 'git exited with code ' + code });
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/github-push", async (req, res) => {
  const { commitMessage } = req.body;
  try {
    const child = spawn('git', ['add', '.'], {
      cwd: WORKSPACE_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.on('close', (code) => {
      if (code === 0) {
        const commitChild = spawn('git', ['commit', '-m', commitMessage], {
          cwd: WORKSPACE_DIR,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let commitErrorData = '';
        commitChild.stderr.on('data', (data) => {
          commitErrorData += data.toString();
        });

        commitChild.on('close', (commitCode) => {
          if (commitCode === 0) {
            const pushChild = spawn('git', ['push'], {
              cwd: WORKSPACE_DIR,
              stdio: ['pipe', 'pipe', 'pipe']
            }); 
            let pushErrorData = '';
            pushChild.stderr.on('data', (data) => {
              pushErrorData += data.toString();
            });

            pushChild.on('close', (pushCode) => {
              if (pushCode === 0) {
                res.json({ success: true });
              } else {
                res.status(500).json({ success: false, error: pushErrorData || 'git push exited with code ' + pushCode });
              }
            });
          } else {
            res.status(500).json({ success: false, error: commitErrorData || 'git commit exited with code ' + commitCode });
          }
        });
      } else {
        res.status(500).json({ success: false, error: errorData || 'git add exited with code ' + code });
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => {
  // console.log(`Server is running at http://localhost:${port}`);
});
