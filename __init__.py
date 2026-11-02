"""Agent Galaxy is dashboard-only (see dashboard/). This module exists so Hermes's agent-side
plugin loader accepts the package; it registers no hooks, tools or commands."""


def register(ctx):
    pass
