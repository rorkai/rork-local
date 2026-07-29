{
  perSystem =
    { pkgs, ... }:
    let
      gitWtHook = import ./git-wt.nix { inherit pkgs; };
    in
    {
      formatter = pkgs.nixfmt-tree;

      # mkShellNoCC: the default stdenv exports DEVELOPER_DIR/SDKROOT pointing
      # at the Nix Apple SDK, which breaks the `xcrun simctl` calls in
      # src/screenshots.ts and src/sim.ts.
      devShells.default = pkgs.mkShellNoCC {
        packages = with pkgs; [
          # dev/build toolchain
          bun
          # `bun start` runs dist/ on plain Node, matching what npx users get
          nodejs_24

          # editor tools
          nixd
          typos

          # utilities
          curl
          gh
          git
          git-wt
          jq
          trash-cli
        ];

        shellHook = ''
          # Install when node_modules is missing or the lockfile is newer.
          if [ ! -d node_modules ] || [ bun.lock -nt node_modules ]; then
            echo "Installing dependencies..."
            bun install --frozen-lockfile
          fi

          # asc (App-Store-Connect-CLI) is not in nixpkgs; the server resolves
          # it from ASC_BIN, then PATH, then a sibling checkout.
          if ! command -v asc >/dev/null 2>&1 && [ -z "$ASC_BIN" ]; then
            echo "note: asc not found - set ASC_BIN=/path/to/asc for publish/screenshot features"
          fi
        ''
        + gitWtHook;
      };
    };
}
