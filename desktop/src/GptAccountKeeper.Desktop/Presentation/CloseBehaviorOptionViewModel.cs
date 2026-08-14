using GptAccountKeeper.Desktop.Models;

namespace GptAccountKeeper.Desktop.Presentation;

internal sealed record CloseBehaviorOptionViewModel(
    CloseBehavior Value,
    string Title,
    string Description);
