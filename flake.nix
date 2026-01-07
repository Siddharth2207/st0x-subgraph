{
  description = "Flake for development workflows.";

  inputs = {
    rainix.url = "github:rainprotocol/rainix";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, rainix, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = rainix.pkgs.${system};
      in rec {
        subgraph-test = rainix.mkTask.${system} {
          name = "subgraph-test";
          body = ''
            set -euxo pipefail
            docker compose up --abort-on-container-exit
          '';
        };

        devShells.default = rainix.devShells.${system}.default.overrideAttrs
          (old: { buildInputs = [ subgraph-test ] ++ old.buildInputs; });

      });

}
