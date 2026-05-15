#!/usr/bin/env bash
# Fix package.json exports to point to dist/ instead of src/
# This makes packages work in production after building

set -euo pipefail

echo "🔧 Fixing package.json exports for production..."
echo ""

# Find all package.json files in packages/ and apps/
PACKAGES=$(find packages apps -name "package.json" -type f | grep -v node_modules)

FIXED=0
SKIPPED=0

for pkg in $PACKAGES; do
  DIR=$(dirname "$pkg")
  
  # Skip if no dist folder exists
  if [ ! -d "$DIR/dist" ]; then
    echo "⏭️  Skipping $pkg (no dist folder)"
    ((SKIPPED++))
    continue
  fi
  
  echo "📝 Fixing $pkg..."
  
  # Use Node to update the package.json
  node -e "
    const fs = require('fs');
    const path = '$pkg';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    
    let changed = false;
    
    // Fix main field
    if (pkg.main && pkg.main.includes('/src/')) {
      pkg.main = pkg.main.replace('/src/', '/dist/').replace('.ts', '.js');
      changed = true;
    }
    
    // Fix types field
    if (pkg.types && pkg.types.includes('/src/')) {
      pkg.types = pkg.types.replace('/src/', '/dist/').replace('.ts', '.d.ts');
      changed = true;
    }
    
    // Fix exports
    if (pkg.exports) {
      Object.keys(pkg.exports).forEach(key => {
        const exp = pkg.exports[key];
        if (typeof exp === 'string') {
          if (exp.includes('/src/')) {
            pkg.exports[key] = exp.replace('/src/', '/dist/').replace('.ts', '.js');
            changed = true;
          }
        } else if (typeof exp === 'object') {
          if (exp.types && exp.types.includes('/src/')) {
            exp.types = exp.types.replace('/src/', '/dist/').replace('.ts', '.d.ts');
            changed = true;
          }
          if (exp.import && exp.import.includes('/src/')) {
            exp.import = exp.import.replace('/src/', '/dist/').replace('.ts', '.js');
            changed = true;
          }
          if (exp.require && exp.require.includes('/src/')) {
            exp.require = exp.require.replace('/src/', '/dist/').replace('.ts', '.js');
            changed = true;
          }
        }
      });
    }
    
    if (changed) {
      fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
      console.log('  ✅ Updated');
    } else {
      console.log('  ⏭️  Already correct');
    }
  "
  
  ((FIXED++))
done

echo ""
echo "✅ Done! Fixed $FIXED packages, skipped $SKIPPED"
echo ""
echo "Next steps:"
echo "  1. Rebuild packages: pnpm build"
echo "  2. Deploy API: cd apps/api && flyctl deploy"
echo "  3. Deploy mail server: cd mailserver && flyctl deploy"
