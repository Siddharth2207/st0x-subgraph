{
  description = "Flake for development workflows.";

  inputs = {
    rainix.url = "github:rainprotocol/rainix";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {self, rainix, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = rainix.pkgs.${system};
      in rec {
        packages = rec{
          the-graph = pkgs.stdenv.mkDerivation rec {
            pname = "the-graph";
            version = "0.69.2";
            src = let
                release-name = "%40graphprotocol%2Fgraph-cli%400.69.2";
                system-mapping = {
                  x86_64-linux = "linux-x64";
                  x86_64-darwin = "darwin-x64";
                  aarch64-darwin = "darwin-arm64";
                };
                system-sha = {
                  x86_64-linux = "sha256:07grrdrx8w3m8sqwdmf9z9zymwnnzxckgnnjzfndk03a8r2d826m";
                  x86_64-darwin = "sha256:0j4p2bkx6pflkif6xkvfy4vj1v183mkg59p2kf3rk48wqfclids8";
                  aarch64-darwin = "sha256:0pq0g0fq1myp0s58lswhcab6ccszpi5sx6l3y9a18ai0c6yzxim0";
                };
              in
              builtins.fetchTarball {
                url = "https://github.com/graphprotocol/graph-tooling/releases/download/${release-name}/graph-${system-mapping.${system}}.tar.gz";
                sha256 = system-sha.${system};
              };
            buildInputs = [];
            installPhase = ''
              mkdir -p $out
              cp -r $src/* $out
            '';
          };
          offchain-assets-subgraph-build = rainix.mkTask.${system} {
              name = "offchain-assets-subgraph-build";
              body = ''
                set -euxo pipefail
                npm install;
                ${the-graph}/bin/graph codegen;
                ${the-graph}/bin/graph build;
              '';
            };
          offchain-assets-subgraph-test = rainix.mkTask.${system} {
            name = "offchain-assets-subgraph-test";
            body = ''
              set -euxo pipefail
              docker compose up --abort-on-container-exit
            '';
          };
        } // rainix.packages.${system};

        devShells.default = pkgs.mkShell {
          packages = [
            packages.offchain-assets-subgraph-build
            packages.offchain-assets-subgraph-test
          ];

          shellHook = rainix.devShells.${system}.default.shellHook;
          buildInputs = rainix.devShells.${system}.default.buildInputs;
          nativeBuildInputs = rainix.devShells.${system}.default.nativeBuildInputs;
        };

      }
    );

}