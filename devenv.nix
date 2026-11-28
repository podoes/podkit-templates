{ pkgs, ... }:
{
  packages = with pkgs; [
    # scripts/build.py and scripts/check_images.py need Python 3.11 or later and nothing else.
    python3
    actionlint
    jq
  ];

  # Builds dist/ and serves the website and the catalog at http://127.0.0.1:8767.
  scripts.serve.exec = ''
    scripts/build.py && exec python3 -m http.server 8767 --bind 127.0.0.1 --directory dist
  '';

  git-hooks.hooks = {
    nixfmt.enable = true;
    actionlint.enable = true;

    # The check CI runs: every template and preset is valid.
    catalog = {
      enable = true;
      name = "catalog";
      entry = "scripts/build.py --check";
      files = "^(templates|presets|scripts)/";
      pass_filenames = false;
    };
  };
}
