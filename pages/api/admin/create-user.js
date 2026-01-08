12:02:33.412 Running build in Washington, D.C., USA (East) – iad1
12:02:33.413 Build machine configuration: 2 cores, 8 GB
12:02:33.543 Cloning github.com/boulet04/evidencia-app (Branch: main, Commit: 3f37270)
12:02:34.680 Cloning completed: 1.137s
12:02:34.775 Restored build cache from previous deployment (EjgcJccCNZ8xhUAG2DWyEDT8AsNk)
12:02:35.172 Running "vercel build"
12:02:35.571 Vercel CLI 50.1.6
12:02:35.888 Installing dependencies...
12:02:38.829 
12:02:38.830 up to date in 3s
12:02:38.830 
12:02:38.830 5 packages are looking for funding
12:02:38.830   run `npm fund` for details
12:02:38.863 Detected Next.js version: 14.2.35
12:02:38.866 Running "npm run build"
12:02:38.960 
12:02:38.960 > build
12:02:38.960 > next build
12:02:38.960 
12:02:39.582   ▲ Next.js 14.2.35
12:02:39.582 
12:02:39.583    Linting and checking validity of types ...
12:02:39.687    Creating an optimized production build ...
12:02:41.243 Failed to compile.
12:02:41.244 
12:02:41.244 ./pages/api/admin/create-user.js
12:02:41.244 Error: 
12:02:41.244   [31mx[0m Expected '}', got '<eof>'
12:02:41.245      ,-[[36;1;4m/vercel/path0/pages/api/admin/create-user.js[0m:129:1]
12:02:41.245  [2m129[0m |     if (password && password.length < 8) {
12:02:41.245  [2m130[0m |       return res.status(400).json({ error: "Mot de passe trop court (8 caractères minimum)." });
12:02:41.245  [2m131[0m |     }
12:02:41.245  [2m132[0m |     if (!password) pass
12:02:41.245      : [31;1m                   ^^^^[0m
12:02:41.246      `----
12:02:41.246 
12:02:41.246   [31mx[0m Expected a semicolon
12:02:41.246      ,-[[36;1;4m/vercel/path0/pages/api/admin/create-user.js[0m:129:1]
12:02:41.246  [2m129[0m |     if (password && password.length < 8) {
12:02:41.246  [2m130[0m |       return res.status(400).json({ error: "Mot de passe trop court (8 caractères minimum)." });
12:02:41.247  [2m131[0m |     }
12:02:41.247  [2m132[0m |     if (!password) pass
12:02:41.247      : [31;1m                       ^[0m
12:02:41.247      `----
12:02:41.247 
12:02:41.247 Caused by:
12:02:41.247     Syntax Error
12:02:41.248 
12:02:41.248 Import trace for requested module:
12:02:41.248 ./pages/api/admin/create-user.js
12:02:41.248 
12:02:41.258 
12:02:41.258 > Build failed because of webpack errors
12:02:41.281 Error: Command "npm run build" exited with 1
