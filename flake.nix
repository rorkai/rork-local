{
  description = "rork-local development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      # The preview streams a live iOS Simulator through `xcrun simctl`, so the
      # dev shell is only useful on macOS. Apple silicon only; Intel Macs are
      # unsupported.
      systems = [
        "aarch64-darwin"
      ];

      imports = [
        ./nix/dev-shell.nix
      ];
    };
}
